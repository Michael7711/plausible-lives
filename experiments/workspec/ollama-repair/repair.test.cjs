const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { parcel, parseProposal, compileChanges, inspect, postJSON } = require('./repair.cjs');
const { options, runCase, main, summarize } = require('./run.cjs');

const proposal = effects => ({ packing_effects: effects, explanation: 'A test proposal.' });
const good = proposal([{ property: 'packed', value: true }]);
const response = value => ({ done: true, done_reason: 'stop', message: { content: JSON.stringify(value) } });

async function temporary(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspec-repair-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

async function inputs() {
    return {
        start: await fs.readFile(path.join(parcel, 'start.workspec.json'), 'utf8'),
        constraints: await fs.readFile(path.join(parcel, 'constraints.workspec.js'), 'utf8'),
        dispatch: await fs.readFile(path.join(parcel, 'invalid.changes.workspec.js'), 'utf8')
    };
}

function mockFetch(t, handler) {
    const original = global.fetch;
    global.fetch = handler;
    t.after(() => { global.fetch = original; });
}

test('restricted JSON accepts typed data, including an ineffective but safe proposal', () => {
    assert.deepEqual(parseProposal(JSON.stringify(good)), good);
    assert.deepEqual(parseProposal(JSON.stringify(proposal([]))), proposal([]));
});

test('malformed JSON and code fences are rejected', () => {
    for (const text of ['not JSON', '```json\n{}\n```', 'null', '[]']) assert.throws(() => parseProposal(text));
});

test('constraint edits, extra keys, wrong types, unknown properties and duplicate effects are rejected', () => {
    const bad = [
        { ...good, constraints: [] }, { ...good, explanation: '' }, { ...good, explanation: 'x'.repeat(1001) },
        proposal([{ property: 'packed', value: 'true' }]),
        proposal([{ property: 'dispatched', value: false }]),
        proposal([{ property: 'packed', value: true, task: 'dispatch_box' }]),
        proposal([{ property: 'state', value: '"); process.exit(); //' }]),
        proposal([{ property: 'packed', value: true }, { property: 'packed', value: false }]),
        proposal([{}, {}, {}])
    ];
    for (const value of bad) assert.throws(() => parseProposal(JSON.stringify(value)));
    assert.throws(() => parseProposal(' '.repeat(20001)));
});

test('explanation is never inserted into executable Changes', () => {
    const source = compileChanges({ ...good, explanation: 'process.exit(99)' }, '// trusted dispatch');
    assert.ok(source.startsWith('// trusted dispatch'));
    assert.ok(source.includes('set("box", "packed", true)'));
    assert.ok(!source.includes('process.exit'));
});

test('CLI options reject unbounded, accidental and malformed runs', () => {
    assert.equal(options(['benchmark', '--cases', '3']).concurrency, 1);
    assert.equal(options(['smoke']).cases, 1);
    for (const args of [[], ['benchmark'], ['benchmark', '--cases', '0'],
        ['smoke', '--cases', '2'], ['benchmark', '--cases', '2', '--concurrency', '5'],
        ['smoke', '--attempts', '99'], ['smoke', '--timeout-ms', 'NaN'],
        ['smoke', '--seed', '1', '--seed', '2'], ['smoke', '--constraints', 'other.js']]) {
        assert.throws(() => options(args));
    }
});

test('real WorkSpec rejects each faulty baseline, accepts repair, preserves the fixed files', async t => {
    const directory = await temporary(t);
    const data = await inputs();
    await fs.writeFile(path.join(directory, 'start.workspec.json'), data.start);
    await fs.writeFile(path.join(directory, 'constraints.workspec.js'), data.constraints);
    for (const effects of [[], [{ property: 'packed', value: false }], [{ property: 'state', value: 'packed' }]]) {
        const checks = await inspect(directory, compileChanges(proposal(effects), data.dispatch), 10000);
        assert.equal(checks.success, false);
        assert.equal(checks.validation.exit_code, 1);
        assert.equal(checks.validation.output.run.complete, true);
        assert.equal(checks.validation.output.problems.length, 1);
        assert.equal(checks.validation.output.problems[0].scope, 'constraint');
        assert.equal(checks.validation.output.problems[0].metric_id, 'parcel.packed_before_dispatch');
        assert.equal(checks.final.exit_code, 0); // Execution still succeeds.
    }
    const accepted = await inspect(directory, compileChanges(good, data.dispatch), 10000);
    assert.equal(accepted.success, true);
    assert.equal(accepted.packing.output.state.objects.box.properties.packed, true);
    assert.equal(accepted.final.output.state.objects.box.properties.dispatched, true);
    assert.equal(await fs.readFile(path.join(directory, 'constraints.workspec.js'), 'utf8'), data.constraints);
    assert.equal(await fs.readFile(path.join(directory, 'start.workspec.json'), 'utf8'), data.start);
});

test('document errors and CLI timeouts cannot be mistaken for successful repairs', async t => {
    const directory = await temporary(t);
    const data = await inputs();
    await fs.writeFile(path.join(directory, 'constraints.workspec.js'), data.constraints);
    await fs.writeFile(path.join(directory, 'start.workspec.json'), '{}');
    const invalid = await inspect(directory, compileChanges(good, data.dispatch), 10000);
    assert.equal(invalid.success, false);
    assert.ok(invalid.validation.output.problems.some(problem => problem.scope === 'document'));
    await fs.writeFile(path.join(directory, 'start.workspec.json'), data.start);
    const timed = await inspect(directory, compileChanges(good, data.dispatch), 1);
    assert.equal(timed.success, false);
    assert.ok(timed.validation.process_error);
});

test('bounded retries record malformed output, a real constraint failure, then success', async t => {
    const directory = await temporary(t);
    const requests = [];
    const replies = [{ done: true, message: { content: 'bad JSON' } }, response(proposal([])), response(good)];
    mockFetch(t, async (url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify(replies.shift()));
    });
    const record = await runCase(path.join(directory, 'case'), { ...options(['smoke']), attempts: 3 }, await inputs(), 1);
    assert.equal(record.success, true);
    assert.deepEqual(record.attempts.map(entry => entry.stage), ['proposal', 'workspec', 'workspec']);
    assert.deepEqual(record.attempts.map(entry => entry.success), [false, false, true]);
    assert.equal(requests.length, 3);
    assert.ok(JSON.parse(requests[2].messages[1].content).validation_feedback.problems.length);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'case/attempt-3/proposal.json'))).packing_effects[0].value, true);
});

test('attempt limit stops ineffective repairs; truncated output is rejected before application', async t => {
    const directory = await temporary(t);
    let calls = 0;
    mockFetch(t, async () => { calls++; return new Response(JSON.stringify(response(proposal([])))); });
    const config = options(['smoke', '--attempts', '1']);
    const failed = await runCase(path.join(directory, 'failed'), config, await inputs(), 1);
    assert.equal(failed.success, false);
    assert.equal(calls, 1);
    global.fetch = async () => new Response(JSON.stringify({ ...response(good), done_reason: 'length' }));
    const truncated = await runCase(path.join(directory, 'truncated'), config, await inputs(), 2);
    assert.equal(truncated.success, false);
    assert.equal(truncated.attempts[0].stage, 'model');
    await assert.rejects(fs.access(path.join(directory, 'truncated/attempt-1/changes.workspec.js')));
});

test('HTTP errors, bad JSON, large responses and request/body timeouts are bounded', async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/error') { res.writeHead(500); res.end('deliberate server error'); }
        else if (req.url === '/bad') res.end('bad JSON');
        else if (req.url === '/large') res.end('x'.repeat(2 * 1024 * 1024 + 1));
        else if (req.url === '/slow') { res.writeHead(200); res.write('{'); }
        else res.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await postJSON(base, {}, 1000), { ok: true });
    await assert.rejects(postJSON(base + '/error', {}, 1000), /HTTP 500/);
    await assert.rejects(postJSON(base + '/bad', {}, 1000), SyntaxError);
    await assert.rejects(postJSON(base + '/large', {}, 1000), /2 MiB/);
    await assert.rejects(postJSON(base + '/slow', {}, 30));
});

test('benchmark scheduler respects concurrency, counts cases and saves checkpoints (mock Ollama)', async t => {
    const directory = await temporary(t);
    let active = 0;
    let maximum = 0;
    let calls = 0;
    mockFetch(t, async url => {
        let body;
        if (url.endsWith('/api/version')) body = { version: 'TEST_ONLY' };
        else if (url.endsWith('/api/tags')) body = { models: [{ name: 'gpt-oss:20b', digest: 'TEST_ONLY' }] };
        else {
            calls++; active++; maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 100));
            active--; body = response(good);
        }
        return new Response(JSON.stringify(body));
    });
    const exit = await main(['benchmark', '--cases', '3', '--concurrency', '2', '--attempts', '1'], directory);
    assert.equal(exit, 0);
    assert.equal(calls, 3);
    assert.equal(maximum, 2);
    const [run] = await fs.readdir(directory);
    const summary = JSON.parse(await fs.readFile(path.join(directory, run, 'summary.json')));
    assert.equal(summary.completed_cases, 3);
    assert.equal(summary.success_rate, 1);
    assert.equal((await fs.readFile(path.join(directory, run, 'cases.jsonl'), 'utf8')).trim().split('\n').length, 3);
});

test('expired budget prevents any model request and unstarted cases are visible in rates', async t => {
    const directory = await temporary(t);
    mockFetch(t, async () => { throw new Error('Model must not be called'); });
    const record = await runCase(path.join(directory, 'case'), options(['smoke']), await inputs(), 1, 0, 0);
    assert.equal(record.success, false);
    assert.equal(record.attempts.length, 0);
    const summary = summarize({ cases: 10 }, [{ success: true, attempts: [{ success: true }], duration_ms: 20 }], 20, 'budget_exhausted');
    assert.equal(summary.success_rate, 1);
    assert.equal(summary.successful_fraction_of_planned, 0.1);
    assert.equal(summary.unstarted_cases, 9);
});

test('CLI preview does not contact Ollama; bad options exit 2', () => {
    const runner = path.join(__dirname, 'run.cjs');
    const dry = spawnSync(process.execPath, [runner, 'benchmark', '--cases', '100', '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0);
    assert.equal(JSON.parse(dry.stdout).maximum_model_calls, 200);
    assert.equal(spawnSync(process.execPath, [runner, 'benchmark'], { encoding: 'utf8' }).status, 2);
});
