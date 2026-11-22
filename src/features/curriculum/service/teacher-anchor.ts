// The seed's `sourceRef` is written for the team and can carry internal notes after a ";".
// The teacher sees only the leading citation, and nothing at all if it still looks internal.
const INTERNAL_MARKER = /docs\/|\.md\b|(?<![\w-])(?:D-0\d|P0-\d)|(?<![\w-])B2\d(?!\w)/;

export function teacherSourceAnchor(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const head = raw.split(";")[0].trim().replace(/\.+$/, "").trim();
  if (head === "" || INTERNAL_MARKER.test(head)) return undefined;
  return head;
}
