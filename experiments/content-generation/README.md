# Stage 3 — Generating structured life examples

The research question is whether local AI can produce batches of useful,
varied Stage 2 documents about people and what might matter to them.
A generated example is fictional data. It is not evidence about a real
person and has not been checked for plausibility by WorkSpec.

## Run it

Use Node.js 18.11 or later and a running local Ollama with the installed
gpt-oss:20b tag. The experiment installs nothing, downloads no model, and
connects only to the Mac's loopback Ollama API. From this directory:

    node --test generation.test.cjs
    node run.cjs --config trials/reference-smoke.json
    node run.cjs --config trials/batch-eight.json --dry-run

Remove the dry-run flag only when you want the longer trial to run.
With no config, the default requests three serial batches of two documents.
Use a small custom config to try a different prompt:

    {
      "promptFile": "my-prompt.txt",
      "briefsFile": "my-briefs.json",
      "batches": 2,
      "batchSize": 3,
      "numCtx": 8192,
      "numPredict": 5000,
      "requestTimeoutMs": 90000,
      "runBudgetMs": 150000
    }

Prompt and brief paths are relative to the config file. Leave either out
to use the experiment's defaults. A brief file is an array of objects with
a distinct slug-shaped id and nonempty brief text; see briefs.json.
briefOffset selects the first brief (zero-based); briefs rotate in order.
seed increments per batch. Repeated briefs get a variant number, which
is a prompt hint, not a guarantee of novelty.

| Setting | Default | What it controls |
| --- | --- | --- |
| model | gpt-oss:20b | Explicit local tag, checked before generation |
| batches / batchSize | 3 / 2 | Serial requests / requested documents per reply; at most 12 per reply and 120 per run |
| numCtx / numPredict | 8192 / 4096 | Requested context and output token budget, including thinking where applicable |
| requestTimeoutMs / runBudgetMs | 120000 / 420000 | Per-call timeout and elapsed budget for scheduling/HTTP |
| seed / temperature / thinking | 31 / 0.7 / low | Sampling, generation variability and reasoning effort |
| minEntityKinds / minPredicates | 4 / 4 | Warning thresholds for distinct labels in those fields |

The program reserves at least 1024 tokens outside numPredict as a sanity
check; this does not tokenize the prompt or guarantee that a long custom
prompt fits. Ollama reports the actual context allocated after each
request, where available. Compare context, token use and resident size in
the saved evidence before increasing them. Ollama's
[context documentation](https://docs.ollama.com/context-length) explains
why allocating more context can consume more memory.

The requests run in the foreground and are serial. A response is capped
at 4 MiB; timeouts include reading the body. After a transport failure
the program stops issuing requests, because the server might still be
finishing the abandoned request. Local file writes can finish just after
the run deadline. Keep the machine awake for a longer run. A process
interruption can lose the in-flight reply, but earlier batches remain
available. There is no automatic resume or background job.

Exit 0 means all requested slots produced distinct, Stage 2-valid documents
with the right response counts. Exit 1 indicates a failed or incomplete
run, including a run with some accepted documents. Exit 2 indicates a
setup/configuration or fatal error. Quality warnings alone do not set
a failure exit code.

## How the pieces fit

1. loadSettings reads a small JSON config and checks its limits.
2. makeRequest selects briefs and builds a chat request. Its format is
   a JSON Schema object for a batch of Stage 2 documents. Ollama's
   [structured-output guide](https://docs.ollama.com/capabilities/structured-outputs)
   describes both this and plain JSON mode. We chose the schema because it
   can describe fields, allowed types and count; neither format proves that
   IDs resolve or that the result is meaningful.
3. runExperiment sends the request, saves the raw reply and calls
   inspectResponse. That function parses the Ollama response, parses its
   content separately, and calls Stage 2's unchanged validateDocument
   for each document in a parsed envelope.
4. measure counts repetition and variety signals; summarize aggregates
   the recorded batches without interpreting the examples as real lives.

Think of the document batch as an ArrayList of records. A Set tracks
document IDs across the run (entity and statement IDs are scoped to their
document), and a Map counts normalized labels like a Java HashMap.
An async function returns a Promise: await waits for the file or HTTP
operation before moving to the next step, roughly like waiting on a
CompletableFuture without blocking other Node work.

## Reading the evidence

Each invocation creates a unique directory inside ignored outputs/.
plan.json records the resolved config, brief set, prompt and validator hash.
model.json records Ollama version, model digest and reported model capacity.
Each batch has request.json (exact prompt and schema), response.txt (raw
response, or bytes received before a transport failure), report.json
(validation, counters, and Ollama's timings), and resident-model.json
when the live memory query succeeds. Accepted JSON files sit beside these;
all rejected content stays in the raw reply. The summary is checkpointed
after each reported batch. Ollama's duration fields are nanoseconds;
requestMs and wallMs are milliseconds.

A complete batch returned the expected number of parseable documents; it
can still contain invalid documents. Truncation, malformed response/content,
wrong envelope, count mismatch, transport/HTTP failure, invalid Stage 2 data
and duplicate document IDs are recorded separately. The denominator for
the headline valid rate is the number requested, including unstarted slots;
there is also a rate over attempted slots. Extra documents are recorded but
never count toward accepted yield. No raw output is executed, rewritten or
silently repaired; fenced JSON is recorded as malformed content.

The automatic metrics are probes:

- Stage 2 validity checks structure, ID uniqueness and links. Valid data may
  still be contradictory or infeasible.
- Repeated normalized entity labels and exact statements flag possible
  repetition. Two different ideas can share a label and synonyms can evade
  detection. Same content expressed with new labels is not reliably caught.
- Distinct entity kinds and predicates, presence of premise/value/option,
  and prompted-brief coverage measure surface variety, not semantic breadth.
  A model can inflate the counts by inventing near-synonyms.
- Review actual text for believable circumstances, whose perspective is
  represented, specificity, agency, stereotyping, internal coherence and
  what is missing. There is no automatic realism or completeness score.

See RESULTS.md for the executed trials and hand-reviewed examples. For future
WorkSpec work, each accepted file is still an ordinary Stage 2 document.
No WorkSpec conversion, constraints, life comparison, or remote hardware
configuration is part of this experiment.
