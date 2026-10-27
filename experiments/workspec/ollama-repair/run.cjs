const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { parcel, inspect, compileChanges, parseProposal, makeRequest, postJSON } = require('./repair.cjs');

const hash = source => createHash('sha256').update(source).digest('hex');
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

function options(argv) {
    const mode = argv.shift();
    if (!['smoke', 'benchmark'].includes(mode)) throw new Error('Usage: node run.cjs smoke | benchmark --cases N [--dry-run] [--attempts N] [--timeout-ms N] [--concurrency N] [--budget-ms N] [--seed N]');
    const config = { mode, model: 'gpt-oss:20b', timeout_ms: 120000, attempts: 2, seed: 1,
        base_url: 'http://127.0.0.1:11434', cases: 1, concurrency: 1, cli_timeout_ms: 10000,
        budget_ms: 8 * 60 * 60 * 1000, dry_run: false };
    const limits = { '--timeout-ms': ['timeout_ms', 1, 600000], '--attempts': ['attempts', 1, 5],
        '--seed': ['seed', 0, 2147480000], '--cases': ['cases', 1, 10000],
        '--concurrency': ['concurrency', 1, 4], '--cli-timeout-ms': ['cli_timeout_ms', 1, 60000],
        '--budget-ms': ['budget_ms', 1, 24 * 60 * 60 * 1000] };
    const used = new Set();
    while (argv.length) {
        const flag = argv.shift();
        if (flag === '--dry-run' && !used.has(flag)) { used.add(flag); config.dry_run = true; continue; }
        const value = argv.shift();
        if (!value || used.has(flag)) throw new Error(`Missing or repeated option: ${flag}`);
        used.add(flag);
        if (Object.hasOwn(limits, flag)) {
            const [key, min, max] = limits[flag];
            const n = Number(value);
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Out-of-range ${flag}`);
            config[key] = n;
        } else if (flag === '--model' && value === 'gpt-oss:20b') config.model = value;
        else throw new Error(`Unknown/unsupported option: ${flag}`);
    }
    if (mode === 'benchmark' && !used.has('--cases')) throw new Error('Benchmark requires an explicit --cases N.');
    if (mode === 'smoke' && (used.has('--cases') || used.has('--concurrency'))) throw new Error('Smoke is exactly one case, concurrency 1.');
    return config;
}

async function prepare(directory, inputs) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'start.workspec.json'), inputs.start);
    await fs.writeFile(path.join(directory, 'constraints.workspec.js'), inputs.constraints);
}

async function checkedInspect(directory, source, inputs, timeoutMs) {
    const result = await inspect(directory, source, timeoutMs);
    for (const [name, expected] of [['start.workspec.json', inputs.start], ['constraints.workspec.js', inputs.constraints]]) {
        if (hash(await fs.readFile(path.join(directory, name))) !== hash(expected)) throw new Error(`Fixed input changed: ${name}`);
    }
    return result;
}

async function runCase(directory, config, inputs, seed, caseIndex = 0, deadline = Infinity) {
    const started = performance.now();
    const faults = [
        { name: 'missing-packing-effects', effects: null },
        { name: 'packed-explicitly-false', effects: [{ property: 'packed', value: false }] },
        { name: 'label-only', effects: [{ property: 'state', value: 'packed' }] }
    ];
    const fault = faults[caseIndex % faults.length];
    const record = { case: caseIndex + 1, fault: fault.name, seed, success: false, attempts: [] };
    await fs.mkdir(directory);
    const baselineDir = path.join(directory, 'baseline');
    await prepare(baselineDir, inputs);
    let source = fault.effects === null ? inputs.dispatch
        : compileChanges({ packing_effects: fault.effects, explanation: 'Deliberately faulty baseline.' }, inputs.dispatch);
    const baseline = await checkedInspect(baselineDir, source, inputs, config.cli_timeout_ms);
    await save(path.join(baselineDir, 'checks.json'), baseline);
    const problems = baseline.validation.output?.problems;
    if (baseline.validation.exit_code !== 1 || !baseline.validation.output?.run?.complete
        || problems?.length !== 1 || problems[0].scope !== 'constraint'
        || problems[0].metric_id !== 'parcel.packed_before_dispatch') {
        throw new Error('Baseline is not the expected executable constraint failure.');
    }
    let feedback = problems;
    let previous = null;
    for (let attempt = 1; attempt <= config.attempts; attempt++) {
        if (Date.now() >= deadline) { record.error = 'Run time budget exhausted.'; break; }
        console.log(`Case seed ${seed}, attempt ${attempt}/${config.attempts}: asking ${config.model}...`);
        const attemptStarted = performance.now();
        const attemptDir = path.join(directory, `attempt-${attempt}`);
        await prepare(attemptDir, inputs);
        const entry = { attempt, success: false, stage: 'model' };
        record.attempts.push(entry);
        try {
            const request = makeRequest({ ...config, seed, start: JSON.parse(inputs.start), constraints: inputs.constraints }, source, feedback, previous);
            await save(path.join(attemptDir, 'request.json'), request);
            const modelStarted = performance.now();
            const response = await postJSON(config.base_url + '/api/chat', request, Math.max(1, Math.min(config.timeout_ms, deadline - Date.now())));
            entry.model_ms = Math.round(performance.now() - modelStarted);
            await save(path.join(attemptDir, 'response.json'), response);
            if (!response.done || response.done_reason === 'length') throw new Error('Incomplete or truncated model response.');
            entry.stage = 'proposal';
            const proposal = parseProposal(response.message?.content);
            previous = proposal;
            await save(path.join(attemptDir, 'proposal.json'), proposal);
            source = compileChanges(proposal, inputs.dispatch);
            entry.stage = 'workspec';
            const checks = await checkedInspect(attemptDir, source, inputs, config.cli_timeout_ms);
            await save(path.join(attemptDir, 'checks.json'), checks);
            entry.success = checks.success;
            feedback = { problems: checks.validation.output?.problems,
                accepted: checks.success, packing: checks.packing.output?.state?.objects?.box,
                final: checks.final.output?.state?.objects?.box };
            if (!checks.success) entry.error = 'Candidate did not pass WorkSpec and state checks.';
        } catch (error) {
            entry.error = error.message;
            entry.error_name = error.name;
            entry.error_code = error.cause?.code || error.code || null;
            feedback = { stage: entry.stage, error: entry.error };
        }
        entry.duration_ms = Math.round(performance.now() - attemptStarted);
        await save(path.join(attemptDir, 'result.json'), entry);
        console.log(`  ${entry.success ? 'PASS' : 'FAIL'} (${entry.duration_ms} ms)${entry.error ? ': ' + entry.error : ''}`);
        if (entry.success) { record.success = true; break; }
    }
    record.duration_ms = Math.round(performance.now() - started);
    await save(path.join(directory, 'result.json'), record);
    return record;
}

function summarize(config, records, elapsedMs, status) {
    const attempts = records.flatMap(record => record.attempts);
    const successes = records.filter(record => record.success).length;
    const first = records.filter(record => record.attempts[0]?.success).length;
    const count = records.length;
    const byFault = {};
    for (const record of records) {
        const group = byFault[record.fault || 'setup-error'] ||= { cases: 0, successes: 0 };
        group.cases++;
        group.successes += Number(record.success);
        group.success_rate = group.successes / group.cases;
    }
    return { status, planned_cases: config.cases, completed_cases: count, unstarted_cases: config.cases - count,
        successes, success_rate: count ? successes / count : null,
        first_attempt_success_rate: count ? first / count : null,
        successful_fraction_of_planned: successes / config.cases,
        attempted_repairs: attempts.length, failed_attempts: attempts.filter(entry => !entry.success).length,
        errors_by_stage: Object.fromEntries(['model', 'proposal', 'workspec'].map(stage =>
            [stage, attempts.filter(entry => !entry.success && entry.stage === stage).length])),
        case_errors: records.filter(record => record.error).length,
        by_fault: byFault,
        mean_case_ms: count ? Math.round(records.reduce((sum, record) => sum + record.duration_ms, 0) / count) : null,
        duration_ms: elapsedMs };
}

async function main(argv, outputBase = path.join(__dirname, 'outputs')) {
    const config = options([...argv]);
    if (config.dry_run) {
        console.log(JSON.stringify({ ...config, maximum_model_calls: config.cases * config.attempts,
            note: 'Preview only. No files, network requests or model calls.' }, null, 2));
        return 0;
    }
    const root = path.join(outputBase, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
    await fs.mkdir(path.dirname(root), { recursive: true });
    await fs.mkdir(root);
    console.log(`Results: ${root}`);
    await save(path.join(root, 'config.json'), config);
    try {
        const inputs = {
            start: await fs.readFile(path.join(parcel, 'start.workspec.json'), 'utf8'),
            constraints: await fs.readFile(path.join(parcel, 'constraints.workspec.js'), 'utf8'),
            dispatch: await fs.readFile(path.join(parcel, 'invalid.changes.workspec.js'), 'utf8')
        };
        await fs.mkdir(path.join(root, 'inputs'));
        for (const [name, source] of Object.entries(inputs)) await fs.writeFile(path.join(root, 'inputs', name + '.txt'), source);
        const implementationHashes = {};
        await fs.mkdir(path.join(root, 'implementation'));
        for (const name of ['run.cjs', 'repair.cjs', 'repair.schema.json', 'package.json']) {
            const bytes = await fs.readFile(path.join(__dirname, name));
            implementationHashes[name] = hash(bytes);
            await fs.writeFile(path.join(root, 'implementation', name), bytes);
        }
        const version = await postJSON(config.base_url + '/api/version', undefined, 5000);
        const tags = await postJSON(config.base_url + '/api/tags', undefined, 5000);
        const model = tags.models?.find(item => item.name === config.model);
        if (!model) throw new Error(`Model ${config.model} is not installed; no automatic download.`);
        await save(path.join(root, 'metadata.json'), { started_at: new Date().toISOString(), node: process.version,
            platform: process.platform, architecture: process.arch,
            workspec: require(path.join(parcel, 'node_modules/workspec/package.json')).version,
            ollama: version, model, implementation_sha256: implementationHashes,
            input_sha256: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, hash(value)])) });
        const started = performance.now();
        const deadline = Date.now() + config.budget_ms;
        const records = [];
        let next = 0;
        let checkpoint = Promise.resolve();
        await save(path.join(root, 'summary.json'), summarize(config, records, 0, 'running'));
        async function worker() {
            while (next < config.cases && Date.now() < deadline) {
                const index = next++;
                const directory = path.join(root, `case-${String(index + 1).padStart(4, '0')}`);
                const caseStarted = performance.now();
                let record;
                try { record = await runCase(directory, config, inputs, config.seed + index, index, deadline); }
                catch (error) {
                    record = { case: index + 1, seed: config.seed + index, success: false, attempts: [],
                        error: error.message, duration_ms: Math.round(performance.now() - caseStarted) };
                    await save(path.join(directory, 'result.json'), record);
                }
                records.push(record);
                // Serialize checkpoint writes when more than one worker finishes together.
                checkpoint = checkpoint.then(async () => {
                    await fs.appendFile(path.join(root, 'cases.jsonl'), JSON.stringify(record) + '\n');
                    await save(path.join(root, 'summary.json'), summarize(config, records, Math.round(performance.now() - started), 'running'));
                });
                await checkpoint;
            }
        }
        await Promise.all(Array.from({ length: Math.min(config.concurrency, config.cases) }, worker));
        await checkpoint;
        const summary = summarize(config, records, Math.round(performance.now() - started),
            records.length === config.cases ? 'finished' : 'budget_exhausted');
        await save(path.join(root, 'summary.json'), summary);
        console.log(JSON.stringify(summary, null, 2));
        return summary.successes === config.cases ? 0 : 1;
    } catch (error) {
        await save(path.join(root, 'fatal-error.json'), { message: error.message, name: error.name, code: error.cause?.code || error.code || null });
        throw error;
    }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.message); process.exitCode = 2; });
module.exports = { options, runCase, summarize, main };
