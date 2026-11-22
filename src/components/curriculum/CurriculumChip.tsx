import { formatTP } from "./format-tp";

export function CurriculumChip({ code }: { code: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-foreground">
      {formatTP(code)}
    </span>
  );
}
