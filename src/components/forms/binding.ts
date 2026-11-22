import type { UseFormRegisterReturn } from "react-hook-form";

/**
 * How a field gets its value: registered with React Hook Form, or (forms that stay on
 * `useActionState`) a plain `name` with an optional `defaultValue`. A registered field may still
 * take a `defaultValue`: React Hook Form fills the value only once the page runs JavaScript, so a
 * form that works without it (sign-up) passes the value for the server render too.
 */
export type FieldBinding =
  | { registration: UseFormRegisterReturn; name?: never; defaultValue?: string }
  | { registration?: never; name: string; defaultValue?: string };

/** The input props of a binding. */
export function bindingProps(binding: FieldBinding) {
  const { registration, defaultValue } = binding;
  return registration
    ? { ...registration, defaultValue }
    : { name: binding.name, defaultValue };
}
