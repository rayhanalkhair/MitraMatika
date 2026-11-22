// How the shell shows the signed-in teacher: a display name and initials.
// The name comes from the session; without one, the email local part stands in.

export function displayNameOf(name: string | null, email: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  return email.split("@")[0] ?? email;
}

export function initialsOf(name: string | null, email: string): string {
  const words = displayNameOf(name, email)
    .split(/[\s._-]+/)
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
}
