const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { performance } = require('node:perf_hooks');
const { loadSettings, makeRequest, inspectResponse, summarize } = require('./generation.cjs');

const endpoint = 'http://127.0.0.1:11434';
const limit = 4 * 1024 * 1024;
const save = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const digest = contents => createHash('sha256').update(contents).digest('hex');

async function request(route, payload, timeoutMs) {
  const chunks = [];
  let bytes = 0;
  try {
    const response = await fetch(endpoint + route, {
      method: payload === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const reader = response.body?.getReader();
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes + value.length > limit) {
        chunks.push(Buffer.from(value.subarray(0, limit - bytes)));
        await reader.cancel();
        throw new Error('Response exceeded 4 MiB.');
      }
      chunks.push(Buffer.from(value));
      bytes += value.length;
    }
    return { ok: response.ok, httpStatus: response.status, raw: Buffer.concat(chunks) };
  } catch (error) {
    return {
      ok: false, error: { name: error.name, message: error.message, code: error.cause?.code ?? null },
      raw: Buffer.concat(chunks)
    };
  }
}

async function metadata(api, route, payload, timeoutMs) {
  const result = await api(route, payload, timeoutMs);
  if (!result.ok) throw new Error(route + ': ' + (result.error?.message || 'HTTP ' + result.httpStatus));
  return JSON.parse(result.raw);
}

async function runExperiment(plan, outputBase, api = request) {
  const started = performance.now();
  const remaining = () => Math.max(0, Math.floor(plan.settings.runBudgetMs - (performance.now() - started)));
  const directory = path.join(outputBase, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  await fs.mkdir(outputBase, { recursive: true });
  await fs.mkdir(directory);
  const reports = [];
  const seenIds = new Set();
  const checkpoint = async status => {
    const summary = { ...summarize(plan, reports, status), wallMs: Math.round(performance.now() - started) };
    await save(path.join(directory, 'summary.tmp'), summary);
    await fs.rename(path.join(directory, 'summary.tmp'), path.join(directory, 'summary.json'));
    return summary;
  };
  console.log('Results: ' + directory);
  await save(path.join(directory, 'plan.json'), {
    ...plan, endpoint, startedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, arch: process.arch,
    stage2ValidatorSha256: digest(await fs.readFile(require.resolve('../general-data/model.cjs'))),
    implementationSha256: Object.fromEntries(await Promise.all(['run.cjs', 'generation.cjs'].map(async name =>
      [name, digest(await fs.readFile(path.join(__dirname, name)))])))
  });
  await checkpoint('running');
  try {
    const ms = Math.max(1, Math.min(5000, remaining(), plan.settings.requestTimeoutMs));
    const model = plan.settings.model;
    const [version, tags, show] = await Promise.all([
      metadata(api, '/api/version', undefined, ms), metadata(api, '/api/tags', undefined, ms),
      metadata(api, '/api/show', { model }, ms)
    ]);
    const tag = tags.models?.find(item => item.name === model);
    if (!tag || !(tag.size > 0) || tag.remote_model || show.remote_model || show.remote_host) {
      throw new Error('Requested model is not verified as installed locally. No download was attempted.');
    }
    const context = Object.entries(show.model_info || {}).find(([key]) => key.endsWith('.context_length'))?.[1];
    await save(path.join(directory, 'model.json'), {
      version, tag, context, details: show.details, thinking: show.thinking, capabilities: show.capabilities
    });
    if (typeof context === 'number' && plan.settings.numCtx > context) throw new Error('numCtx exceeds the installed model context limit.');
    if (show.thinking?.values && plan.settings.thinking !== null && !show.thinking.values.includes(plan.settings.thinking)) {
      throw new Error('Requested thinking level is not supported by the installed model.');
    }
    let stoppedAfterTransportError = false;
    for (let batch = 0; batch < plan.settings.batches && remaining() > 0; batch++) {
      const batchDir = path.join(directory, 'batch-' + String(batch + 1).padStart(3, '0'));
      await fs.mkdir(batchDir);
      const { slots, payload } = makeRequest(plan, batch);
      await save(path.join(batchDir, 'request.json'), { slots, payload });
      if (remaining() === 0) break;
      const timeoutMs = Math.min(plan.settings.requestTimeoutMs, remaining());
      const requestStart = performance.now();
      const result = await api('/api/chat', payload, timeoutMs);
      const requestMs = Math.round(performance.now() - requestStart);
      await fs.writeFile(path.join(batchDir, 'response.txt'), result.raw);
      const report = result.ok ? inspectResponse(result.raw, slots, plan.settings, seenIds)
        : { status: result.httpStatus ? 'http-error' : result.error?.name === 'TimeoutError' ? 'timeout' : 'transport-error', documents: [] };
      Object.assign(report, { batch: batch + 1, slots, timeoutMs, requestMs, httpStatus: result.httpStatus, error: result.error });
      for (const doc of report.documents) {
        if (doc.status === 'valid') {
          const filename = 'document-' + String(doc.slot).padStart(2, '0') + '.json';
          await save(path.join(batchDir, filename), doc.document);
          doc.file = filename;
        }
        delete doc.document; // Full candidates, including rejected ones, stay in response.txt.
      }
      await save(path.join(batchDir, 'report.json'), report);
      reports.push(report);
      await checkpoint('running');
      if (remaining() > 0) {
        try {
          const ps = await metadata(api, '/api/ps', undefined, Math.max(1, Math.min(2000, remaining())));
          await save(path.join(batchDir, 'resident-model.json'), ps.models?.find(item => item.name === model) ?? null);
        } catch (error) {
          await save(path.join(batchDir, 'resident-model-error.json'), { message: error.message });
        }
      }
      console.log('Batch ' + (batch + 1) + ': ' + report.status + '; '
        + report.documents.filter(doc => doc.status === 'valid').length + '/' + slots.length + ' valid; ' + requestMs + ' ms');
      // A disconnected client cannot prove Ollama has stopped. Don't queue more work.
      if (['timeout', 'transport-error'].includes(report.status)) {
        stoppedAfterTransportError = true;
        break;
      }
    }
    const status = reports.length === plan.settings.batches ? 'finished' : remaining() === 0 ? 'budget-exhausted'
      : stoppedAfterTransportError ? 'stopped-after-transport-error' : 'budget-exhausted';
    const summary = await checkpoint(status);
    console.log(JSON.stringify(summary, null, 2));
    return { directory, summary };
  } catch (error) {
    await save(path.join(directory, 'error.json'), { message: error.message });
    await checkpoint('fatal-error');
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const plan = await loadSettings(values.config);
  if (values['dry-run']) {
    console.log(JSON.stringify({ settings: plan.settings, slots: Array.from({ length: plan.settings.batches },
      (_, batch) => makeRequest(plan, batch).slots) }, null, 2));
    return;
  }
  const { summary } = await runExperiment(plan, path.join(__dirname, 'outputs'));
  process.exitCode = summary.validRateOfRequested === 1 && summary.batchStatuses.complete === plan.settings.batches ? 0 : 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 2; });
module.exports = { runExperiment };
