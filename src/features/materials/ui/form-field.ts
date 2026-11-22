/** A text field of a submitted form (a file or a missing field gives `fallback`). */
export function fieldOf(form: HTMLFormElement, name: string, fallback = ""): string {
  const value = new FormData(form).get(name);
  return typeof value === "string" ? value : fallback;
}
