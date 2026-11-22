// Test fixture: answers with its own start and end time after `ms` milliseconds.
import { parentPort, workerData } from "node:worker_threads";

const started = Date.now();
setTimeout(() => {
  parentPort.postMessage({ started, ended: Date.now() });
}, workerData.ms);
