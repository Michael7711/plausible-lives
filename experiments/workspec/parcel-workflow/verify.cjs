// Small regression check: invoke the real CLI, then inspect its JSON results.
// These are Node's built-in modules; no additional packages are needed.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const cli = path.join(__dirname, "node_modules/workspec/bin/workspec.js");

function run(command, options = [], expectedExit = 0) {
    const args = [command, "start.workspec.json", ...options, "--json"];
    const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: __dirname, encoding: "utf8", timeout: 10000
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedExit, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
}

const document = run("validate", ["--no-changes", "--no-generator", "--no-constraints"]);
assert.equal(document.validation.mode, "document");
assert.equal(document.run, null);
assert.deepEqual(document.problems, []);

const horizon = ["--time", "09:15"];
const valid = run("validate", [...horizon, "--yes"]);
assert.equal(valid.validation.mode, "project");
assert.equal(valid.run.complete, true);
assert.deepEqual(valid.problems, []);

for (const [time, packed, dispatched] of [
    ["09:09", false, false], ["09:10", true, false], ["09:15", true, true]
]) {
    const snapshot = run("snapshot", ["--time", time]);
    assert.deepEqual(snapshot.problems, []);
    assert.equal(snapshot.state.objects.box.properties.packed, packed);
    assert.equal(snapshot.state.objects.box.properties.dispatched, dispatched);
    if (time === "09:15") {
        assert.deepEqual(snapshot.state.task_statuses, {
            pack_box: "completed", dispatch_box: "completed"
        });
    }
}

const broken = ["--changes", "invalid.changes.workspec.js", ...horizon];
const invalid = run("validate", [...broken, "--yes"], 1);
assert.equal(invalid.run.complete, true);
assert.equal(invalid.run.resolved_through, 555);
assert.equal(invalid.problems.length, 1);
const problem = invalid.problems[0];
assert.equal(problem.scope, "constraint");
assert.equal(problem.metric_id, "parcel.packed_before_dispatch");
assert.equal(problem.severity, "error");
assert.equal(problem.context.time, 555);
assert.equal(problem.context.observed, false);
assert.equal(problem.context.expected, true);

// Snapshot executes changes but does NOT evaluate domain constraints.
const invalidSnapshot = run("snapshot", broken);
assert.deepEqual(invalidSnapshot.problems, []);
assert.equal(invalidSnapshot.state.objects.box.properties.packed, false);
assert.equal(invalidSnapshot.state.objects.box.properties.dispatched, true);

const constraints = run("constraints", [...broken, "--yes"], 1);
assert.deepEqual(constraints.problems, []);
assert.equal(constraints.violations.length, 1);
assert.equal(constraints.violations[0].constraint_id, "parcel.packed_before_dispatch");
console.log("PASS: 8 real CLI runs checked. Document valid; normal scenario valid;");
console.log("broken scenario produces exactly the expected constraint error (exit 1).");
