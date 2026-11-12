const fs = require('node:fs/promises');
const path = require('node:path');
const { validateDocument } = require('../general-data/model.cjs');

const defaults = {
  model: 'gpt-oss:20b', batches: 3, batchSize: 2, briefOffset: 0, seed: 31,
  numCtx: 8192, numPredict: 4096, temperature: 0.7, thinking: 'low',
  requestTimeoutMs: 120000, runBudgetMs: 420000, minEntityKinds: 4, minPredicates: 4
};
const ranges = {
  batches: [1, 100], batchSize: [1, 12], briefOffset: [0, 100000], seed: [0, 2147483000],
  numCtx: [2048, 131072], numPredict: [128, 32768],
  requestTimeoutMs: [50, 900000], runBudgetMs: [50, 28800000],
  minEntityKinds: [1, 20], minPredicates: [1, 30]
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const slugPattern = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';

async function loadSettings(file) {
  const overrides = file ? JSON.parse(await fs.readFile(file, 'utf8')) : {};
  if (!record(overrides)) throw new Error('Configuration must be a JSON object.');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, key) && !['promptFile', 'briefsFile'].includes(key)) {
      throw new Error('Unknown setting: ' + key);
    }
  }
  const settings = { ...defaults, ...overrides };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) {
      throw new Error(key + ' must be an integer between ' + min + ' and ' + max);
    }
  }
  // Reserve some room for the schema and prompt; this is not tokenization.
  if (settings.numPredict + 1024 > settings.numCtx) throw new Error('Reserve at least 1024 context tokens beyond numPredict.');
  if (settings.batches * settings.batchSize > 120) throw new Error('A run may request at most 120 documents.');
  if (typeof settings.temperature !== 'number' || settings.temperature < 0 || settings.temperature > 2) throw new Error('temperature must be 0–2.');
  if (![null, 'low', 'medium', 'high'].includes(settings.thinking)) throw new Error('thinking must be null, low, medium or high.');
  if (typeof settings.model !== 'string' || !/^[\w./-]+:[\w.-]+$/.test(settings.model)
    || /(?:^|[-:])cloud(?:$|[-.])/i.test(settings.model)) {
    throw new Error('Choose an explicitly tagged local model.');
  }
  const base = file ? path.dirname(path.resolve(file)) : __dirname;
  const read = async (key, fallback) => {
    const filename = Object.hasOwn(overrides, key) ? path.resolve(base, overrides[key]) : path.join(__dirname, fallback);
    const content = await fs.readFile(filename, 'utf8');
    if (!text(content) || Buffer.byteLength(content) > 20000) throw new Error(key + ' must contain 1–20000 bytes of text.');
    return content;
  };
  const prompt = await read('promptFile', 'prompt.txt');
  const briefs = JSON.parse(await read('briefsFile', 'briefs.json'));
  if (!Array.isArray(briefs) || !briefs.length || briefs.some(item => !record(item)
    || typeof item.id !== 'string' || !new RegExp(slugPattern).test(item.id) || !text(item.brief))
    || new Set(briefs.map(item => item.id)).size !== briefs.length) {
    throw new Error('Briefs must have distinct slug IDs and non-empty descriptions.');
  }
  return { settings, prompt, briefs };
}

// This shape guides Ollama; the unchanged Stage 2 validator remains authoritative.
function responseSchema(batchSize) {
  const object = (properties, required = Object.keys(properties)) =>
    ({ type: 'object', properties, required, additionalProperties: false });
  const slug = { type: 'string', pattern: slugPattern };
  const label = { type: 'string', minLength: 1 };
  const entity = object({ id: slug, kind: slug, label });
  const statement = object({
    id: slug, kind: { enum: ['premise', 'value', 'option'] }, subject: slug, predicate: slug,
    object: { anyOf: [label, { type: 'boolean' }, { type: 'number' }, object({ ref: slug })] }, context: label
  }, ['id', 'kind', 'subject', 'predicate', 'object']);
  const document = object({
    schemaVersion: { const: 1 }, id: slug, entities: { type: 'array', items: entity },
    statements: { type: 'array', items: statement }
  });
  return object({ documents: { type: 'array', minItems: batchSize, maxItems: batchSize, items: document } });
}

function makeRequest({ settings, prompt, briefs }, batch) {
  const schema = responseSchema(settings.batchSize);
  const slots = Array.from({ length: settings.batchSize }, (_, index) => {
    const offset = settings.briefOffset + batch * settings.batchSize + index;
    const { id, brief } = briefs[offset % briefs.length];
    return { slot: index + 1, briefId: id, brief, variant: Math.floor(offset / briefs.length) + 1 };
  });
  return {
    slots,
    payload: {
      model: settings.model, stream: false, format: schema, keep_alive: '3m',
      ...(settings.thinking !== null ? { think: settings.thinking } : {}),
      options: { num_ctx: settings.numCtx, num_predict: settings.numPredict, temperature: settings.temperature, seed: settings.seed + batch },
      messages: [
        { role: 'system', content: prompt + '\nUse this JSON Schema: ' + JSON.stringify(schema) },
        { role: 'user', content: 'Produce exactly one Stage 2 document per slot in order. Give each document a descriptive, distinct id. Fictional briefs:\n' + JSON.stringify(slots) }
      ]
    }
  };
}

// Indicators of wording/shape only; two synonyms can evade them.
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function counts(keys) {
  const result = new Map();
  for (const key of keys) result.set(key, (result.get(key) || 0) + 1);
  return result;
}
const repeats = keys => [...counts(keys)].filter(([, n]) => n > 1).map(([key, count]) => ({ key, count }));
function measure(document, settings) {
  const entityKinds = [...new Set(document.entities.map(item => item.kind))];
  const predicates = [...new Set(document.statements.map(item => item.predicate))];
  const missingKinds = ['premise', 'value', 'option'].filter(kind => !document.statements.some(item => item.kind === kind));
  const labels = document.entities.map(item => normalize(item.label)).filter(Boolean);
  const duplicateLabels = repeats(labels);
  const duplicateStatements = repeats(document.statements.map(item => JSON.stringify([
    item.kind, item.subject, item.predicate, item.object, item.context ?? ''
  ])));
  return {
    entityCount: document.entities.length, statementCount: document.statements.length,
    entityKinds, predicates, labels, missingKinds, duplicateLabels, duplicateStatements,
    warnings: [
      ...(entityKinds.length < settings.minEntityKinds ? ['low-entity-kind-variety'] : []),
      ...(predicates.length < settings.minPredicates ? ['low-predicate-variety'] : []),
      ...(missingKinds.length ? ['missing-statement-kinds'] : []),
      ...(duplicateLabels.length ? ['repeated-label'] : []),
      ...(duplicateStatements.length ? ['repeated-statement'] : [])
    ]
  };
}

function inspectResponse(raw, slots, settings, seenIds) {
  let reply, content;
  try { reply = JSON.parse(raw); } catch { return { status: 'malformed-response', documents: [] }; }
  const timing = Object.fromEntries(['total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration',
    'eval_count', 'eval_duration'].filter(key => typeof reply?.[key] === 'number').map(key => [key, reply[key]]));
  const fail = status => ({ status, documents: [], timing });
  if (reply?.done_reason === 'length') return fail('truncated');
  if (reply?.done !== true || typeof reply?.message?.content !== 'string') {
    return fail('malformed-response');
  }
  try { content = JSON.parse(reply.message.content); } catch { return fail('malformed-content'); }
  if (!record(content) || Object.keys(content).length !== 1 || !Array.isArray(content.documents)) {
    return fail('invalid-envelope');
  }
  const documents = content.documents.map((document, index) => {
    const issues = validateDocument(document);
    const briefId = slots[index]?.briefId ?? null;
    if (issues.length) return { slot: index + 1, briefId, status: 'invalid-document', issues };
    const metrics = measure(document, settings);
    const status = !briefId ? 'extra-document' : seenIds.has(document.id) ? 'duplicate-document-id' : 'valid';
    if (status === 'valid') seenIds.add(document.id);
    return { slot: index + 1, briefId, status, id: document.id, metrics, document };
  });
  return {
    status: documents.length === slots.length ? 'complete' : 'count-mismatch', documents, timing
  };
}

function summarize(plan, reports, status) {
  const docs = reports.flatMap(batch => batch.documents);
  const valid = docs.filter(doc => doc.status === 'valid');
  const requestedDocuments = plan.settings.batches * plan.settings.batchSize;
  const attemptedDocuments = reports.length * plan.settings.batchSize;
  const labelCoverage = new Map();
  for (const doc of valid) for (const label of new Set(doc.metrics.labels)) {
    if (!labelCoverage.has(label)) labelCoverage.set(label, []);
    labelCoverage.get(label).push(doc.id);
  }
  const issueCodes = docs.flatMap(doc => (doc.issues || []).map(issue => issue.code));
  return {
    status, plannedBatches: plan.settings.batches, completedBatches: reports.length,
    requestedDocuments, attemptedDocuments, unstartedDocuments: requestedDocuments - attemptedDocuments,
    returnedDocuments: docs.length,
    validDocuments: valid.length, validRateOfRequested: valid.length / requestedDocuments,
    validRateOfAttemptedSlots: attemptedDocuments ? valid.length / attemptedDocuments : null,
    failureRateOfAttemptedSlots: attemptedDocuments ? (attemptedDocuments - valid.length) / attemptedDocuments : null,
    batchStatuses: Object.fromEntries(counts(reports.map(batch => batch.status))),
    documentStatuses: Object.fromEntries(counts(docs.map(doc => doc.status))),
    validationIssues: Object.fromEntries(counts(issueCodes)),
    warningDocuments: Object.fromEntries(counts(valid.flatMap(doc => doc.metrics.warnings))),
    requestedBriefsWithValidDocuments: [...new Set(valid.map(doc => doc.briefId))],
    distinctEntityKinds: new Set(valid.flatMap(doc => doc.metrics.entityKinds)).size,
    distinctPredicates: new Set(valid.flatMap(doc => doc.metrics.predicates)).size,
    repeatedLabelsAcrossDocuments: [...labelCoverage].filter(([, ids]) => ids.length > 1)
      .map(([label, documentIds]) => ({ label, documentIds }))
  };
}

module.exports = { loadSettings, makeRequest, measure, inspectResponse, summarize };
