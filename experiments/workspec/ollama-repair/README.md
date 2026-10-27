# Experiment 002 — local Ollama AI repair

This small experiment asks `gpt-oss:20b` to repair the parcel scenario from
Experiment 001. The AI proposes **data**, our code translates that data into
WorkSpec Changes, and WorkSpec judges the result using the original constraints.
Nothing is applied back to Experiment 001.

## Start here

Requirements: Node.js 18+, Experiment 001's existing local WorkSpec installation,
and a running local Ollama server with `gpt-oss:20b` already installed. Verified
with Node 26.12.1, WorkSpec 1.2.5 and Ollama 0.40.3 on 27 October 2026.
There are **no new npm dependencies** and no SDK to install here.

```sh
cd /Users/mc/dev/plausible-lives/experiments/workspec/ollama-repair

# Deterministic software checks; no real model generation required.
npm test

# One live case, at most one model call, with a saved result directory.
npm run smoke -- --attempts 1
```

`npm run smoke` without the extra option allows at most two attempts on its one
case. A failed proposal is sent back as feedback for the next attempt.
`ollama list` can check whether the model is installed. The runner does not start
Ollama or download models for you. If the sibling WorkSpec installation is missing,
restore it with `npm ci` in `../parcel-workflow`, not by adding dependencies here.

Exit codes: **0** means every requested case was repaired; **1** means a case
failed or the run stopped before completing all cases; **2** means bad command
options or a fatal setup/output error. The test command exits 0 when its expected
failure cases behave correctly.

## The architecture

```text
Experiment 001 inputs (read only)
        |
        v
WorkSpec runs the faulty baseline and reports its constraint violation
        |
        v
Ollama receives the scenario, fixed rule, error and repair JSON Schema
        |
        v
JSON parsing and strict allowlist checks       <- reject unsafe/malformed data
        |
        v
Fixed template builds a candidate Changes file in a new output directory
        |
        v
WorkSpec validation + snapshots at 09:10 and 09:15
        |
        +--> pass: save success
        +--> fail: save feedback, retry only within the attempt/time limits
```

| File | Why it exists |
| --- | --- |
| `repair.schema.json` | Describes the only data the model may return. Sent to Ollama as its structured-output format. |
| `repair.cjs` | Parses and checks proposals, builds trusted Changes text, calls the WorkSpec CLI, checks states and communicates with Ollama over local HTTP. |
| `run.cjs` | Coordinates smoke/benchmark runs, fixed input copies, attempts, limits, progress and saved results. |
| `repair.test.cjs` | Tests the repair boundary, real WorkSpec acceptance/rejection, retry behaviour, HTTP failures and benchmark scheduling. |
| `package.json` | Gives the three npm commands; no dependencies are declared because we reuse the sibling experiment's WorkSpec CLI. |
| `README.md` | This guide and the initial measured results. |

`.cjs` means a CommonJS JavaScript file running in Node.js. `require(...)` loads
another file or a Node built-in module. In the tests, `assert.equal(...)` checks
that an observed value matches an expected one. A failed assertion fails the test.

## The repair contract

An example proposal is:

```json
{
  "packing_effects": [
    { "property": "packed", "value": true },
    { "property": "state", "value": "packed" }
  ],
  "explanation": "Restore the packing facts when pack_box completes."
}
```

These replace **all** packing completion effects for task `pack_box`, object
`box`. The task, object and completion phase are fixed by our code. An effect
may set `packed` to a boolean, or `state` to `packed`/`unpacked`. At most two
effects are allowed, with no duplicate properties. Unknown fields, wrong types,
code fences, invalid JSON and oversized proposals are rejected. The explanation
must be a short string and is saved as text; it never enters executable code.

There are two different checks:

1. **Is the proposal allowed?** The small hand-written validator checks the
   fixed contract independently of Ollama. It is not a general JSON Schema
   engine. Update the schema, validator and tests together if extending it.
2. **Does the allowed proposal repair the scenario?** WorkSpec checks the fixed
   constraint. Empty effects and `packed: false` are safe to represent, but fail
   the domain rule. Changing only the `state` label also fails.

The compiler inserts only validated booleans and enum strings into a fixed
`WorkSpec.task(...).onComplete(...)` template. It preserves Experiment 001's
trusted dispatch source verbatim. It does not use `eval`, shell interpolation,
model-provided file paths or model-provided JavaScript.

The initial JSON state, task timings, dispatch code and constraint definition
are outside the model's editable surface. Each candidate gets the original
starting state and constraint source; their SHA-256 hashes are checked after
execution. Generator discovery is explicitly disabled.

Acceptance requires complete WorkSpec validation with zero problems, the box
packed and not dispatched at 09:10, and both tasks completed with the box packed
and dispatched at 09:15. A zero exit code from a snapshot alone is insufficient.
These state checks also prevent passing by simply avoiding dispatch.

## What has actually run

- Experiment 001 was rerun first: **all eight real CLI checks passed**.
- Experiment 002: **13 tests passed**, including expected failures. Tests use
  real WorkSpec processes, simulated model replies and temporary local HTTP
  servers. They do not measure the AI's performance.
- Before implementing benchmark mode, one live smoke case succeeded on its first
  attempt: **14.719 seconds** total, including model loading. The attempt took
  14.543 seconds. The raw model response reported about 9.913 seconds loading.
- After adding benchmark mode, a short three-case live verification run succeeded
  **3/3 on the first attempt**, concurrency 1, in **10.471 seconds** total.
  Attempt times were 3.049, 3.592 and 3.255 seconds. This run was limited to three
  cases, one attempt each and a 90-second time budget.

Run directories under this experiment's ignored `outputs/` directory:

- Initial smoke: `2026-10-27T03-05-40-749Z-c0b39bd6`
- Three-case verification: `2026-10-27T03-10-37-516Z-5f8f486a`

The smoke response's explanation incorrectly said either effect alone would
satisfy the constraint. Its proposed repair contained both and passed, but that
explanation is false: the `packed` boolean is required. The raw output is kept,
and the label-only failure is covered by a real WorkSpec test. Treat explanations
as material to examine, not validated findings.

## Optional bounded benchmark — not started as an overnight run

Preview settings without making requests or writing results:

```sh
npm run benchmark -- --cases 100 --attempts 2 --timeout-ms 120000 --concurrency 1 --budget-ms 28800000 --dry-run
```

For a future run, manually use the same command without `--dry-run`.
It runs in the foreground: keep the terminal open and the Mac awake. This
experiment does not install a scheduler or run a background service.

| Option | Default / limit |
| --- | --- |
| `--cases` | Required for benchmark; 1–10,000. Smoke always has one case. |
| `--attempts` | 2; range 1–5 per case, including failed requests. |
| `--timeout-ms` | 120,000 per model request, including its response body; maximum 600,000. |
| `--cli-timeout-ms` | 10,000 per WorkSpec process; maximum 60,000. |
| `--concurrency` | 1 case worker; maximum 4 for benchmark only. |
| `--budget-ms` | 28,800,000 (8 hours); maximum 24 hours. Stops new cases/attempts and caps remaining model-request time. |
| `--seed` | 1 initially; each case uses initial seed + case index. |
| `--dry-run` | Preview only. |

An in-flight WorkSpec inspection may finish after the run budget; each of its
three CLI processes has its own timeout. Allow up to three CLI timeouts plus
file-writing overhead after the budget. A disconnected client is not proof that
Ollama immediately stopped server-side generation.

Model settings are deliberately fixed: `gpt-oss:20b`, temperature 0, thinking
`low`, context 8192, output budget 1024 tokens, streaming off and keep-alive 5m.
Requests go only to `http://127.0.0.1:11434`; no cloud endpoint is configured.

Cases rotate through three small faults: missing packing effects, an explicitly
false `packed` value, and a label-only packing effect. Counts above three repeat
these fault types with different seeds. This is a plumbing/repeated-trial check,
not a broad benchmark of human-life modelling or general repair ability.
Temperature 0 and seeds do not guarantee bit-for-bit reproducibility across
runtime/hardware versions, nor independent statistical trials.

## Reading the recorded results

Each run gets a unique directory, so earlier results are preserved:

```text
outputs/<timestamp-id>/
  config.json                  chosen run limits and model name
  metadata.json                model digest/details, versions, source hashes
  inputs/                      exact starting state, rule and dispatch source
  implementation/              copies of the runner, helper, schema and package
  summary.json                 counts, rates, timings, errors by stage/fault
  cases.jsonl                  one saved record per finished case
  case-0001/
    baseline/                  faulty Changes, fixed files and checks.json
    attempt-1/
      request.json             full prompt, schema, model options and seed
      response.json            raw successful HTTP response, including model output
      proposal.json            parsed proposal, if it passed local checks
      changes.workspec.js      candidate, only after proposal validation
      start.workspec.json      fixed starting state copy
      constraints.workspec.js  fixed constraint copy
      checks.json              CLI commands, exit codes, raw outputs and timings
      result.json              attempt outcome/error and elapsed time
    result.json                case outcome and attempt summaries
```

HTTP/transport errors are saved in the attempt result; no `response.json` is
created when a complete successful HTTP response was not received. Setup failures
produce `fatal-error.json`. Model truncation, malformed proposals and WorkSpec
rejections are separate stages. Progress is saved after each case. An interrupted
run can retain a `running` summary; it is not evidence of completion. Resume of an
interrupted run is not implemented; a new invocation starts a new directory.

`success_rate` uses finished case records as its denominator, including failed
records. `successful_fraction_of_planned` uses all requested cases, and
`unstarted_cases` makes budget-limited runs visible. First-attempt rate and failed
attempt counts keep later repairs from concealing earlier errors. Durations are
milliseconds; raw Ollama duration fields are nanoseconds. Model timings can
include loading or queuing, especially if concurrency is increased.

To replay a candidate manually, replace `RUN` with a printed directory name:

```sh
../parcel-workflow/node_modules/.bin/workspec validate outputs/RUN/case-0001/attempt-1/start.workspec.json --time 09:15 --no-generator --json --yes
```

Sibling Changes and Constraints are discovered by this command. The saved
`checks.json` also contains the exact explicit commands used by the runner.

## Suggested study order and limitations

First compare Experiment 001's correct and invalid Changes. Next read
`repair.schema.json`, then `parseProposal`/`compileChanges` in `repair.cjs`.
Follow `runCase` in `run.cjs`, and finally look at the tests and saved request,
proposal and checks from the smoke run.

A useful first exercise: run `npm test` and find the label-only failure case.
Predict why `state: "packed"` is insufficient, then compare it with the fixed
constraint. Keep the constraint unchanged while investigating repairs.

This is a narrow proof of concept. It repairs only packing effects, trusts the
human-authored local WorkSpec sources, and proves compliance only with the
existing parcel rule and explicit state checks. It does not establish physical
realism, test new unseen tasks or validate the model's explanation. No overnight
run, automatic commit or push is part of this experiment.

API design reference: [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
and [chat API](https://docs.ollama.com/api/chat). WorkSpec behaviour was checked
against the locally installed README/declarations and real CLI executions.
