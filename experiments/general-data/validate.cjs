const { readFileSync } = require('node:fs');
const { validateDocument } = require('./model.cjs');

function main(args) {
  if (args.length !== 1) {
    console.error('Usage: node validate.cjs <document.json>');
    return 2;
  }
  let document;
  try {
    document = JSON.parse(readFileSync(args[0], 'utf8'));
  } catch (error) {
    console.error(error instanceof SyntaxError ? `Invalid JSON: ${error.message}` : `Cannot read input: ${error.message}`);
    return 2;
  }
  const issues = validateDocument(document);
  console.log(JSON.stringify({ valid: issues.length === 0, issues }, null, 2));
  return issues.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
