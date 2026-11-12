// Version 1 is a research hypothesis. Labels and predicates have no built-in meaning.
const VERSION = 1;
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KINDS = ['premise', 'value', 'option'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSlug = value => typeof value === 'string' && SLUG.test(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;

// Returns issues instead of stopping at the first mistake. Does not modify the input.
function validateDocument(document) {
  const issues = [];
  const add = (path, code, message) => issues.push({ path, code, message });

  function checkFields(record, path, required, optional = []) {
    if (!isRecord(record)) {
      add(path, 'type', 'Expected an object.');
      return false;
    }
    for (const key of required) {
      if (!Object.hasOwn(record, key)) add(`${path}.${key}`, 'required', 'Missing field.');
    }
    for (const key of Object.keys(record)) {
      if (!required.includes(key) && !optional.includes(key)) {
        add(`${path}[${JSON.stringify(key)}]`, 'unknown-field', 'Field is not in version 1.');
      }
    }
    return true;
  }

  function check(record, key, path, predicate, message) {
    if (Object.hasOwn(record, key) && !predicate(record[key])) {
      add(`${path}.${key}`, 'invalid-value', message);
    }
  }

  function registerId(id, path, ids) {
    if (!isSlug(id)) return; // The field check reports missing or malformed IDs.
    if (ids.has(id)) add(path, 'duplicate-id', `ID "${id}" is already used in this list.`);
    ids.add(id);
  }

  // Entity IDs are collected first, so references do not depend on list order.
  function checkReference(id, path, ids) {
    if (!isSlug(id)) add(path, 'invalid-value', 'Expected an entity ID.');
    else if (ids && !ids.has(id)) add(path, 'unknown-reference', `No entity has ID "${id}".`);
  }

  function checkObject(value, path, entityIds) {
    if (isRecord(value)) {
      checkFields(value, path, ['ref']);
      if (Object.hasOwn(value, 'ref')) checkReference(value.ref, `${path}.ref`, entityIds);
    } else if (!isText(value) && !Number.isFinite(value) && typeof value !== 'boolean') {
      add(path, 'invalid-value', 'Expected text, a finite number, a boolean or { "ref": "entity-id" }.');
    }
  }

  if (!isRecord(document)) {
    add('$', 'type', 'Expected a document object.');
    return issues;
  }
  if (Object.hasOwn(document, 'schemaVersion') && document.schemaVersion !== VERSION) {
    add('$.schemaVersion', 'unsupported-version', `Expected schemaVersion ${VERSION}.`);
    return issues;
  }
  checkFields(document, '$', ['schemaVersion', 'id', 'entities', 'statements']);
  check(document, 'id', '$', isSlug, 'Expected a document ID in lower-kebab-case.');
  check(document, 'entities', '$', Array.isArray, 'Expected an array of entities.');
  check(document, 'statements', '$', Array.isArray, 'Expected an array of statements.');

  const entityIds = Array.isArray(document.entities) ? new Set() : null;
  if (entityIds) {
    document.entities.forEach((entity, index) => {
      const path = `$.entities[${index}]`;
      if (!checkFields(entity, path, ['id', 'kind', 'label'])) return;
      check(entity, 'id', path, isSlug, 'Expected an entity ID in lower-kebab-case.');
      check(entity, 'kind', path, isSlug, 'Expected a kind in lower-kebab-case.');
      check(entity, 'label', path, isText, 'Expected non-blank text.');
      registerId(entity.id, `${path}.id`, entityIds);
    });
  }

  if (Array.isArray(document.statements)) {
    const statementIds = new Set();
    document.statements.forEach((statement, index) => {
      const path = `$.statements[${index}]`;
      if (!checkFields(statement, path, ['id', 'kind', 'subject', 'predicate', 'object'], ['context'])) return;
      check(statement, 'id', path, isSlug, 'Expected a statement ID in lower-kebab-case.');
      registerId(statement.id, `${path}.id`, statementIds);
      check(statement, 'kind', path, kind => KINDS.includes(kind), 'Expected premise, value or option.');
      check(statement, 'predicate', path, isSlug, 'Expected a predicate in lower-kebab-case.');
      check(statement, 'context', path, isText, 'Expected non-blank text.');
      if (Object.hasOwn(statement, 'subject')) checkReference(statement.subject, `${path}.subject`, entityIds);
      if (Object.hasOwn(statement, 'object')) checkObject(statement.object, `${path}.object`, entityIds);
    });
  }
  return issues;
}

module.exports = { validateDocument };
