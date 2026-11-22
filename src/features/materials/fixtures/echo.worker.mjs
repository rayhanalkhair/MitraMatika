import { parentPort, workerData } from "node:worker_threads";

// Test worker: answers with what it was given.
parentPort.postMessage({
  echo: workerData.value,
  bytes: new Uint8Array(workerData.bytes).length,
});
