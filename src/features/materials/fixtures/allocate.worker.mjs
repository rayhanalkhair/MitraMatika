// Test worker: keeps allocating until the heap limit kills it.
const hold = [];
for (;;) hold.push(new Array(1_000_000).fill(Math.random()));
