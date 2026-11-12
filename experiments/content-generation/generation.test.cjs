const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadSettings, makeRequest, measure, inspectResponse, summarize } = require('./generation.cjs');
const { runExperiment } = require('./run.cjs');
const fixture = require('../general-data/examples/neighbourhood.json');

const slots = [{ briefId: 'care' }, { briefId: 'music' }];
const thresholds = { minEntityKinds: 4, minPredicates: 4 };
const reply = (documents, extra = {}) => JSON.stringify({
  done: true, done_reason: 'stop', message: { content: JSON.stringify({ documents }) }, ...extra
});
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'life-generation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('config changes prompt, briefs, batch size and limits with paths relative to the config', async t => {
  const dir = await temp(t);
  await fs.writeFile(path.join(dir, 'own-prompt.txt'), 'Focus on agency.');
  await fs.writeFile(path.join(dir, 'own-briefs.json'), '[{"id":"one","brief":"One"},{"id":"two","brief":"Two"}]');
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ promptFile: 'own-prompt.txt', briefsFile: 'own-briefs.json', batches: 2,
    batchSize: 1, briefOffset: 1, numCtx: 16384, numPredict: 5000, requestTimeoutMs: 9000, runBudgetMs: 30000 }));
  const plan = await loadSettings(file);
  assert.equal(plan.settings.runBudgetMs, 30000);
  assert.equal(plan.settings.requestTimeoutMs, 9000);
  const first = makeRequest(plan, 0);
  assert.equal(first.slots[0].briefId, 'two');
  assert.equal(makeRequest(plan, 1).slots[0].variant, 2);
  assert.equal(first.payload.format.properties.documents.maxItems, 1);
  assert.equal(first.payload.options.num_ctx, 16384);
  assert.equal(first.payload.options.num_predict, 5000);
  assert.match(first.payload.messages[0].content, /Focus on agency/);
});

test('rejects excessive bounds, cloud tags and unknown settings before any requests', async t => {
  const dir = await temp(t);
  const file = path.join(dir, 'config.json');
  for (const config of [{ batches: 100, batchSize: 12 }, { batchSize: 0 }, { numCtx: 2048 },
    { model: 'gpt-oss:20b-cloud' }, { runBudgetMs: 100000000 }, { unexpected: true }]) {
    await fs.writeFile(file, JSON.stringify(config));
    await assert.rejects(loadSettings(file));
  }
});

test('distinguishes malformed outer JSON, incomplete content, wrong envelope and truncation', () => {
  for (const [raw, status] of [
    ['{"', 'malformed-response'], ['null', 'malformed-response'],
    [reply([], { message: { content: 'not JSON' } }), 'malformed-content'],
    [reply([], { message: { content: '{"items":[]}' } }), 'invalid-envelope'],
    [reply([fixture], { done_reason: 'length' }), 'truncated']
  ]) {
    assert.equal(inspectResponse(raw, slots, thresholds, new Set()).status, status);
  }
});

test('uses the Stage 2 validator for references and duplicate IDs', () => {
  const broken = structuredClone(fixture);
  broken.entities.push(broken.entities[0]);
  broken.statements[0].object = { ref: 'missing-entity' };
  const result = inspectResponse(reply([fixture, broken]), slots, thresholds, new Set());
  assert.equal(result.documents[0].status, 'valid');
  assert.equal(result.documents[1].status, 'invalid-document');
  assert.deepEqual(result.documents[1].issues.map(issue => issue.code), ['duplicate-id', 'unknown-reference']);
});

test('counts short batches, extras and repeated document IDs without inflating yield', () => {
  const short = inspectResponse(reply([fixture]), slots, thresholds, new Set());
  assert.equal(short.status, 'count-mismatch');
  const second = { ...fixture, id: 'new-id' };
  const extra = inspectResponse(reply([fixture, fixture, second]), slots, thresholds, new Set());
  assert.deepEqual(extra.documents.map(doc => doc.status), ['valid', 'duplicate-document-id', 'extra-document']);
  const summary = summarize({ settings: { batches: 2, batchSize: 2 } }, [extra], 'budget-exhausted');
  assert.equal(summary.validRateOfRequested, 0.25);
  assert.equal(summary.validRateOfAttemptedSlots, 0.5);
  assert.equal(summary.failureRateOfAttemptedSlots, 0.5);
  assert.equal(summary.unstartedDocuments, 2);
  assert.equal(summary.returnedDocuments, 3);
});

test('detects low variety and repeated concepts without declaring a document structurally invalid', () => {
  const document = {
    schemaVersion: 1, id: 'thin-document',
    entities: [{ id: 'a', label: 'Shared Tool', kind: 'object' }, { id: 'b', label: 'SHARED-tool!', kind: 'object' }],
    statements: [{ id: 's1', kind: 'value', subject: 'a', predicate: 'values', object: { ref: 'b' } }]
  };
  document.statements.push({ ...document.statements[0], id: 's2' });
  assert.deepEqual(measure(document, thresholds).warnings, [
    'low-entity-kind-variety', 'low-predicate-variety', 'missing-statement-kinds', 'repeated-label', 'repeated-statement'
  ]);
  const accepted = inspectResponse(reply([document, { ...document, id: 'different-id' }]), slots, thresholds, new Set());
  assert.ok(accepted.documents.every(doc => doc.status === 'valid'));
  const summary = summarize({ settings: { batches: 1, batchSize: 2 } }, [accepted], 'finished');
  assert.deepEqual(summary.repeatedLabelsAcrossDocuments, [{ label: 'shared tool', documentIds: ['thin-document', 'different-id'] }]);
});

test('saves raw success and failure responses, accepted documents and checkpoints (fake Ollama)', async t => {
  const dir = await temp(t);
  const plan = await loadSettings();
  Object.assign(plan.settings, { batches: 2, batchSize: 1 });
  const encode = value => ({ ok: true, raw: Buffer.from(JSON.stringify(value)) });
  let n = 0;
  const api = async (route, payload, timeout) => {
    assert.ok(timeout > 0 && timeout <= plan.settings.requestTimeoutMs);
    if (route === '/api/version') return encode({ version: 'test' });
    if (route === '/api/tags') return encode({ models: [{ name: plan.settings.model, size: 123 }] });
    if (route === '/api/show') return encode({ model_info: { 'fake.context_length': 16384 } });
    if (route === '/api/ps') return encode({ models: [] });
    assert.equal(route, '/api/chat');
    assert.equal(payload.stream, false);
    return ++n === 1 ? { ok: true, raw: Buffer.from(reply([fixture])) }
      : { ok: false, httpStatus: 500, raw: Buffer.from('server failure') };
  };
  const { directory, summary } = await runExperiment(plan, dir, api);
  assert.equal(summary.validDocuments, 1);
  assert.deepEqual(summary.batchStatuses, { complete: 1, 'http-error': 1 });
  assert.equal(await fs.readFile(path.join(directory, 'batch-002/response.txt'), 'utf8'), 'server failure');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'batch-001/document-01.json'), 'utf8')), fixture);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'summary.json'), 'utf8')).completedBatches, 2);
});

test('budget stops new requests while preserving the completed response', async t => {
  const dir = await temp(t);
  const plan = await loadSettings();
  Object.assign(plan.settings, { batches: 2, batchSize: 1, runBudgetMs: 300, requestTimeoutMs: 500 });
  const encode = value => ({ ok: true, raw: Buffer.from(JSON.stringify(value)) });
  let n = 0;
  const api = async (route, payload, timeout) => {
    if (route === '/api/version' || route === '/api/show') return encode({});
    if (route === '/api/tags') return encode({ models: [{ name: plan.settings.model, size: 1 }] });
    assert.equal(route, '/api/chat');
    assert.ok(timeout <= 300);
    n++;
    await new Promise(resolve => setTimeout(resolve, 320));
    return { ok: false, error: { name: 'TimeoutError' }, raw: Buffer.from('partial') };
  };
  const { directory, summary } = await runExperiment(plan, dir, api);
  assert.equal(n, 1);
  assert.equal(summary.status, 'budget-exhausted');
  assert.equal(summary.batchStatuses.timeout, 1);
  assert.equal(await fs.readFile(path.join(directory, 'batch-001/response.txt'), 'utf8'), 'partial');
});

test('the selected real examples remain valid Stage 2 documents', async () => {
  const directory = path.join(__dirname, 'examples');
  const names = await fs.readdir(directory);
  assert.equal(names.length, 4);
  for (const name of names) {
    const document = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    assert.equal(inspectResponse(reply([document]), [slots[0]], thresholds, new Set()).documents[0].status, 'valid', name);
  }
});
