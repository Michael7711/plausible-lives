// WorkSpec supplies WorkSpec and set when it executes this file.
WorkSpec.task("pack_box", task => {
    task.onComplete(() => {
        set("box", "packed", true);
        set("box", "state", "packed");
    });
});

WorkSpec.task("dispatch_box", task => {
    task.onComplete(() => {
        set("box", "dispatched", true);
        set("box", "state", "dispatched");
    });
});
