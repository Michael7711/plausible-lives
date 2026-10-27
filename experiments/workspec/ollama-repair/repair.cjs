// Data from the model crosses exactly one boundary: parseProposal().
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const schema = require('./repair.schema.json');
const parcel = path.resolve(__dirname, '../parcel-workflow');
const cli = path.join(parcel, 'node_modules/workspec/bin/workspec.js');

function exactKeys(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));
}

function validateProposal(value) {
    // This checks our small fixed contract, not arbitrary JSON Schemas.
    if (!exactKeys(value, ['packing_effects', 'explanation'])) {
        throw new Error('Expected only packing_effects and explanation.');
    }
    const length = typeof value.explanation === 'string' ? [...value.explanation].length : 0;
    if (length < 1 || length > 1000) throw new Error('explanation must be 1–1000 characters.');
    if (!Array.isArray(value.packing_effects) || value.packing_effects.length > 2) {
        throw new Error('packing_effects must contain at most two effects.');
    }
    const seen = new Set();
    for (const effect of value.packing_effects) {
        if (!exactKeys(effect, ['property', 'value'])) throw new Error('Invalid effect keys.');
        const allowed = (effect.property === 'packed' && typeof effect.value === 'boolean')
            || (effect.property === 'state' && ['packed', 'unpacked'].includes(effect.value));
        if (!allowed) throw new Error('Only a packed boolean or a packed/unpacked state is allowed.');
        if (seen.has(effect.property)) throw new Error('Duplicate properties are forbidden.');
        seen.add(effect.property);
    }
    return value;
}

function parseProposal(content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 20000) {
        throw new Error('Missing or oversized JSON proposal.');
    }
    return validateProposal(JSON.parse(content));
}

function compileChanges(proposal, trustedDispatch) {
    validateProposal(proposal);
    const writes = proposal.packing_effects.map(effect =>
        `        set("box", ${JSON.stringify(effect.property)}, ${JSON.stringify(effect.value)});`
    ).join('\n');
    // Only validated primitive values enter this fixed template. Never insert explanation.
    return `${trustedDispatch}\nWorkSpec.task("pack_box", task => {\n`
        + `    task.onComplete(() => {\n${writes}\n    });\n});\n`;
}

async function runWorkSpec(command, directory, time, timeoutMs = 10000) {
    const args = [cli, command, path.join(directory, 'start.workspec.json'),
        '--changes', path.join(directory, 'changes.workspec.js'), '--no-generator',
        '--time', time, '--seed', '1', '--json'];
    if (command === 'validate') args.push('--constraints', path.join(directory, 'constraints.workspec.js'), '--yes');
    const started = performance.now();
    return new Promise(resolve => {
        execFile(process.execPath, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                let output = null;
                try { output = JSON.parse(stdout); } catch { /* Preserve raw output on failure. */ }
                resolve({ command: [process.execPath, ...args],
                    exit_code: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
                    process_error: error && !Number.isInteger(error.code) ? error.message : null,
                    duration_ms: Math.round(performance.now() - started), stdout, stderr, output });
            });
    });
}

async function inspect(directory, source, timeoutMs) {
    await fs.writeFile(path.join(directory, 'changes.workspec.js'), source);
    const validation = await runWorkSpec('validate', directory, '09:15', timeoutMs);
    const [packing, final] = await Promise.all([
        runWorkSpec('snapshot', directory, '09:10', timeoutMs),
        runWorkSpec('snapshot', directory, '09:15', timeoutMs)
    ]);
    const clean = result => result.exit_code === 0 && result.output?.problems?.length === 0;
    const packed = packing.output?.state?.objects?.box?.properties;
    const dispatched = final.output?.state?.objects?.box?.properties;
    const statuses = final.output?.state?.task_statuses;
    const success = clean(validation) && validation.output.run?.complete === true
        && validation.output.run.resolved_through === 555 && clean(packing) && clean(final)
        && packed?.packed === true && packed?.dispatched === false
        && dispatched?.packed === true && dispatched?.dispatched === true
        && statuses?.pack_box === 'completed' && statuses?.dispatch_box === 'completed';
    return { success, validation, packing, final };
}

function makeRequest(config, source, feedback, previous = null) {
    return {
        model: config.model, stream: false, think: 'low', keep_alive: '5m', format: schema,
        options: { temperature: 0, seed: config.seed, num_predict: 1024, num_ctx: 8192 },
        messages: [
            { role: 'system', content: 'You repair a small parcel WorkSpec. Return JSON only, no code. '
                + 'Propose replacement onComplete effects for task pack_box, object box. '
                + 'Do not change constraints, dispatch, the initial state, or timing. '
                + 'Your explanation is for the student. Contract: ' + JSON.stringify(schema) },
            { role: 'user', content: JSON.stringify({
                starting_state: config.start, fixed_constraints: config.constraints,
                current_changes: source, validation_feedback: feedback,
                previous_rejected_proposal: previous
            }) }
        ]
    };
}

async function postJSON(endpoint, body, timeoutMs) {
    const response = await fetch(endpoint, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
    // Bound even a faulty local server's response. The timeout includes body reads.
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Ollama response exceeds 2 MiB.'); }
        chunks.push(Buffer.from(value));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${raw.slice(0, 1000)}`);
    return JSON.parse(raw);
}

module.exports = { schema, parcel, cli, parseProposal, validateProposal, compileChanges, inspect, makeRequest, postJSON };
