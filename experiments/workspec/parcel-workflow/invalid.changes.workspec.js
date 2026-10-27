// Deliberate bug: pack_box finishes, but its packing effects are missing.
// A completed task does not automatically change an object's properties.
WorkSpec.task("dispatch_box", task => {
    task.onComplete(() => {
        set("box", "dispatched", true);
        set("box", "state", "dispatched");
    });
});
