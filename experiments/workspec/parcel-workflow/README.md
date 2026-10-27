# Experiment 001 — a working parcel WorkSpec

One worker packs one box, then dispatches it. The question is small: can a
correctly structured, executable project still describe an unacceptable outcome?
Yes: the deliberately broken version dispatches a box without packing it.

## Run it

Use Node.js 18 or newer. The existing local dependency is WorkSpec **1.2.5**;
its current starting-state format is **2.2**. These are different version numbers.
No new libraries are required. Run from this directory:

```sh
cd /Users/mc/dev/plausible-lives/experiments/workspec/parcel-workflow
npm test
npm run validate:document
npm run validate:valid
npm run validate:invalid
npm run snapshot
```

`npm test` passes only if the correct scenario succeeds AND the broken scenario
fails for the expected constraint reason. The individual `validate:invalid`
command deliberately exits **1**; that is the expected experimental result.
The other commands above exit **0**.

The exact local CLI commands behind the two scenario checks are:

```sh
./node_modules/.bin/workspec validate start.workspec.json --time 09:15 --json --yes
./node_modules/.bin/workspec validate start.workspec.json --changes invalid.changes.workspec.js --time 09:15 --json --yes
```

`--yes` acknowledges execution of our trusted JavaScript constraint file.
`--json` requests structured output; `--time 09:15` runs through that time.
The CLI automatically discovers sibling `changes.workspec.js` and
`constraints.workspec.js`. `--changes` replaces the discovered Changes source;
it does not add a second Changes file. No Generator file is needed here.

## Files and how they fit together

| File | Purpose |
| --- | --- |
| `start.workspec.json` | Starting state: the desk, worker and box, plus the planned tasks and their timing. JSON stores data, not executable effects. |
| `changes.workspec.js` | Correct effects: packing completion sets `packed` to true; dispatch completion sets `dispatched` to true. Both update the display-like `state` label. |
| `invalid.changes.workspec.js` | Deliberately faulty alternative: only the dispatch effects exist. The packing task still completes, but has no packing effect. |
| `constraints.workspec.js` | Rule: whenever the resolved box is dispatched, `packed` must be true. Reports the first violating event state. |
| `verify.cjs` | Small check script using Node's built-in tools. Runs the actual CLI eight times and checks exit codes, state and the specific constraint error. It is not a second simulation engine. |
| `package.json` | Existing npm project; now includes convenient commands. |
| `package-lock.json` | Existing dependency lock; left unchanged. |

The flow is:

```text
Starting state + selected Changes file
                  |
                  v
          WorkSpec executes tasks
                  |
                  v
        Resolved states and history
             /             \
            v               v
       snapshot         Constraints
    (inspect state)   (judge the result)
```

The runtime interprets `WorkSpec.task("pack_box", ...)` as attaching behaviour
to the JSON task with that ID. `task.onComplete(...)` registers a function to run
when that task finishes. `set("box", "packed", true)` sets a property on that
object. WorkSpec provides these names when it loads the file; you do not need
to write imports. An arrow function such as `() => { ... }` is a block of code
saved for WorkSpec to call later.

A constraint is also a function. It reads the resolved history using `ctx.times()`
and `ctx.getAt(...)`. It returns `null` if the rule holds, or an object describing
the violation. It observes the simulation; it does not repair or stop dispatch.
The loop checks each resolved event time up to the requested time, so a bad
earlier state is not hidden by a later repair.

## What happens

| Time | Event | Correct box: packed / dispatched | Broken box: packed / dispatched |
| --- | --- | --- | --- |
| 09:00 | Packing starts | false / false | false / false |
| 09:10 | Packing completes; dispatch starts | true / false | false / false |
| 09:15 | Dispatch completes | true / true | false / true |

`depends_on: ["pack_box"]` makes dispatch wait for the packing task to finish.
A dependency checks task completion, not whether the task had the right effects.
That is why the domain constraint is useful even with a dependency.
`packed` and `dispatched` are separate true/false facts so packing remains visible
after the `state` label changes from `packed` to `dispatched`.

Dispatch is represented by a property change at the desk. This experiment does
not model transport, packaging supplies or the worker's changing availability.
The rule checks observable event states; it does not require a positive time gap
between packing and dispatch. These limits keep the example small and explicit.

## Executed results and validation layers

Verified locally on 20 October 2026 with WorkSpec 1.2.5:

- Document-only validation: exit **0**, `run: null`, `problems: []`.
- Correct project: exit **0**, `run.complete: true`, `problems: []`.
- Broken project: exit **1**, `run.complete: true`, exactly one error with
  `scope: "constraint"` and `metric_id: "parcel.packed_before_dispatch"`.
  The observed `packed` value is `false`; the expected value is `true`.
- Both final snapshots: exit **0**, runtime `problems: []`. The correct box is
  packed and dispatched; the broken box is dispatched but unpacked.
- `npm test`: exit **0**, eight actual CLI runs checked, including correct state
  at 09:09, 09:10 and 09:15 and a separate failing `constraints` command.

WorkSpec reports 09:15 as **555** minutes from midnight (9 × 60 + 15).

There are different questions involved in validation:

1. **Document validation:** is the starting-state structure and its declarative
   meaning acceptable? To run just this layer, use `npm run validate:document`.
   The bundled JSON Schema is deliberately broad; the package's semantic
   validator is the canonical check. A broken JSON file would fail before
   execution; an unsupported task field or value can produce a document problem.
2. **Source and runtime checks:** can the JavaScript load, and can WorkSpec
   execute the project? A syntax error or an execution problem is different
   from our deliberate violation.
3. **Constraint validation:** does the resolved behaviour satisfy our rule?
   Here execution succeeds, but the broken version produces:
   `A parcel must be packed before it is dispatched.`

The `snapshot` command does not evaluate Constraints. A successful snapshot
alone therefore cannot prove a scenario follows the domain rules. You can
inspect the broken outcome separately:

```sh
./node_modules/.bin/workspec snapshot start.workspec.json --changes invalid.changes.workspec.js --time 09:15 --json
./node_modules/.bin/workspec constraints start.workspec.json --changes invalid.changes.workspec.js --time 09:15 --json --yes
```

The first exits 0; the second exits 1, with a `violations` array and no runtime
`problems`. The automated check requires exactly the expected constraint error,
so it will not mistake a syntax error or unrelated failure for experimental success.

## Study and modify it

Read the starting-state JSON first: find the two objects and two tasks. Then
read the correct Changes file, the deliberately broken file, and the Constraint,
in that order. Read `verify.cjs` last; it checks the example rather than defining it.

Try this small change yourself:

1. Change `pack_box.duration` from `"10m"` to `"5m"` in the starting state.
2. Run `npm run validate:valid` and `npm run snapshot` again. They should pass.
3. Inspect 09:05 with `./node_modules/.bin/workspec snapshot start.workspec.json --time 09:05 --json`.
   Packing should now be complete. Dispatch still waits until its explicit
   09:10 start; a dependency is a requirement, not an instruction to start early.
4. Restore `"10m"` and run `npm test`. The fixed-timeline checks intentionally
   describe the original experiment and would need updating for a new timeline.

To repair the broken scenario, use the normal Changes file again, or add the
missing `pack_box` completion handler from it to your alternative file. Keep the
constraint unchanged: repair the model's behaviour, not the rule used to judge it.

## Implementation basis and preservation

Before authoring, the installed package's README examples, `--help`,
`v2.2.schema.json`, Changes/Constraints declarations, and relevant semantic
validator/runtime code were inspected. The bundled README documents the syntax
used here; no online schema download or invented file format is required.
You can study those sources under `node_modules/workspec/`.

The pre-existing starting state already passed document validation. Its desk,
worker, box, packing task and existing properties were preserved. Added two box
flags and a dependent dispatch task; updated the description. Updated only the
npm scripts in the existing package file. Added the four JavaScript files and
this README. The dependency, lockfile and unrelated project files were left
unchanged. No Git commit, push or Ollama integration was performed.
