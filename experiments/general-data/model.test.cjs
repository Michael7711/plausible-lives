const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { validateDocument } = require('./model.cjs');
const valid = require('./examples/neighbourhood.json');
const invalid = require('./examples/invalid.json');

function issueKeys(document) {
  return validateDocument(document).map(issue => [issue.path, issue.code]);
}

test('accepts the cross-domain fixture without modifying it', () => {
  const before = structuredClone(valid);
  assert.deepEqual(validateDocument(valid), []);
  assert.deepEqual(valid, before);
});

test('accepts a new entity kind and predicates without requiring a person as subject', () => {
  const document = {
    schemaVersion: 1,
    id: 'different-domain',
    entities: [{ id: 'wetland', kind: 'wetland', label: 'A wetland' }],
    statements: [
      { id: 'dry', kind: 'premise', subject: 'wetland', predicate: 'is-dry', object: false },
      { id: 'restoration', kind: 'option', subject: 'wetland', predicate: 'could-be-restored', object: true },
      { id: 'status', kind: 'premise', subject: 'wetland', predicate: 'level', object: 0 }
    ]
  };
  assert.deepEqual(validateDocument(document), []);
});

test('allows partial documents and does not assume missing facts are false', () => {
  const document = { schemaVersion: 1, id: 'partial', entities: [], statements: [] };
  assert.deepEqual(validateDocument(document), []);
});

test('reports distinct structural and reference issues from one file', () => {
  assert.deepEqual(issueKeys(invalid), [
    ['$.entities[1].id', 'duplicate-id'],
    ['$.statements[0].object.ref', 'unknown-reference'],
    ['$.statements[1].kind', 'invalid-value'],
    ['$.statements[1].subject', 'unknown-reference'],
    ['$.statements[1].object', 'invalid-value']
  ]);
});

test('reports duplicate statement IDs and accepts reference targets regardless of entity order', () => {
  const document = structuredClone(valid);
  document.entities.reverse();
  assert.deepEqual(validateDocument(document), []);
  document.statements.push(document.statements[0]);
  assert.deepEqual(issueKeys(document), [[`$.statements[${document.statements.length - 1}].id`, 'duplicate-id']]);
});

test('rejects wrong document versions, missing fields and unexpected fields', () => {
  assert.deepEqual(issueKeys({ ...valid, schemaVersion: 2 }), [['$.schemaVersion', 'unsupported-version']]);
  const document = structuredClone(valid);
  delete document.entities[0].label;
  document.statements[0].priority = 10;
  assert.deepEqual(issueKeys(document), [
    ['$.entities[0].label', 'required'],
    ['$.statements[0]["priority"]', 'unknown-field']
  ]);
});

test('rejects malformed arrays and records without crashing', () => {
  assert.deepEqual(issueKeys(null), [['$', 'type']]);
  assert.deepEqual(issueKeys({ ...valid, entities: {}, statements: [null] }), [
    ['$.entities', 'invalid-value'],
    ['$.statements[0]', 'type']
  ]);
});

test('requires an explicit reference object and does not coerce numbers or booleans', () => {
  const document = structuredClone(valid);
  document.statements[0].object = 'unlisted-entity';
  assert.deepEqual(validateDocument(document), []); // A string is literal text.
  for (const value of [[], null, Infinity, '', { ref: 1 }, { ref: 'ari', extra: false }]) {
    document.statements[0].object = value;
    assert.ok(validateDocument(document).length > 0);
  }
});

test('shape validation does not resolve conflicting premises or prove feasibility', () => {
  const document = structuredClone(valid);
  const access = document.statements.find(statement => statement.id === 'market-access');
  document.statements.push({ ...access, id: 'conflicting-market-access', object: true });
  assert.deepEqual(validateDocument(document), []);
});

test('CLI distinguishes valid data, model errors and unreadable or malformed JSON', t => {
  const run = name => spawnSync(process.execPath, [path.join(__dirname, 'validate.cjs'), name], {
    cwd: __dirname, encoding: 'utf8'
  });
  const pass = run('examples/neighbourhood.json');
  assert.equal(pass.status, 0);
  assert.deepEqual(JSON.parse(pass.stdout), { valid: true, issues: [] });
  const fail = run('examples/invalid.json');
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).issues.length, 5);

  const dir = mkdtempSync(path.join(tmpdir(), 'plausible-lives-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broken = path.join(dir, 'broken.json');
  writeFileSync(broken, '{');
  const syntaxError = run(broken);
  assert.equal(syntaxError.status, 2);
  assert.match(syntaxError.stderr, /^Invalid JSON:/);
  const missing = run(path.join(dir, 'missing.json'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^Cannot read input:/);
});
