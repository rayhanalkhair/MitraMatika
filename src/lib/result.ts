/**
 * The shared outcome of a service call that can fail for an expected reason (validation, not
 * found, quota, upstream error, denied). Services return it; they throw only for real bugs.
 * Server Actions and route handlers map it to their own form state or HTTP shape at the boundary.
 */
export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E };

/** A success. `ok()` with no argument is a `Result<void, never>`. */
export function ok(): Result<void, never>;
export function ok<T>(data: T): Result<T, never>;
export function ok<T>(data?: T): Result<T | undefined, never> {
  return { ok: true, data };
}

/** A failure carrying the expected error payload. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
