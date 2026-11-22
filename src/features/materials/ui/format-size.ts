import type { useFormatter } from "next-intl";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** "300 MB", "1,2 GB", "0,4 MB": one decimal at most, in the viewer's locale. */
export function formatSize(
  bytes: number,
  format: ReturnType<typeof useFormatter>,
): string {
  return bytes >= GB
    ? `${format.number(bytes / GB, { maximumFractionDigits: 1 })} GB`
    : `${format.number(bytes / MB, { maximumFractionDigits: 1 })} MB`;
}
