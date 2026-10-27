// Check observable event states, including earlier events in this run.
WorkSpec.constraint("parcel.packed_before_dispatch", ctx => {
    for (const time of ctx.times()) {
        if (time > ctx.time) continue;
        const dispatched = ctx.getAt(time, "box", "dispatched");
        const packed = ctx.getAt(time, "box", "packed");
        if (dispatched === true && packed !== true) {
            return {
                severity: "error",
                time,
                objects: ["box"],
                property: "packed",
                observed: packed,
                expected: true,
                message: "A parcel must be packed before it is dispatched."
            };
        }
    }
    return null; // No violation found.
});
