import type { JobHandler } from "./handler";

export interface JobRegistry {
  register(type: string, handler: JobHandler): void;
  get(type: string): JobHandler | undefined;
}

export function createRegistry(): JobRegistry {
  const handlers = new Map<string, JobHandler>();
  return {
    register(type, handler) {
      if (handlers.has(type))
        throw new Error(`Job handler for "${type}" is already registered`);
      handlers.set(type, handler);
    },
    get(type) {
      return handlers.get(type);
    },
  };
}
