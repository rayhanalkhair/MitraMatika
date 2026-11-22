// Ruling R15: whether the packages a parsing worker imports can be loaded from where the bundler
// put the worker files (it copies them unbundled, so their imports resolve from node_modules at
// run time, and only the functions listed in next.config.ts carry those files). Started by
// dependencies.ts; posts exactly one message: { missing: string[] }.
import { parentPort, workerData } from "node:worker_threads";

const missing = [];
for (const name of workerData.packages) {
  try {
    await import(name);
  } catch {
    missing.push(name);
  }
}
parentPort.postMessage({ missing });
