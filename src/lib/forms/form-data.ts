// Readers for the FormData a form posts. A Server Action builds its schema's raw input with these
// (`xFormValues(data)`), so the browser (React Hook Form values) and the server parse the same
// shape: strings, string arrays for checkbox groups, booleans for single checkboxes.

/** The form's current entries, as the browser would post them. */
export function formDataOf(form: HTMLFormElement): FormData {
  return new FormData(form);
}

/** The text value of `name`; empty when it is missing or a file. Not trimmed (the schema does). */
export function text(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

/** Every text value of `name` in DOM order (a checkbox group posts only the checked ones). */
export function texts(data: FormData, name: string): string[] {
  return data.getAll(name).filter((value): value is string => typeof value === "string");
}

/** Whether a single checkbox was checked (an unchecked one is not posted at all). */
export function checked(data: FormData, name: string): boolean {
  return data.has(name);
}
