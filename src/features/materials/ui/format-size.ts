import type { useFormatter } from "next-intl";

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/**
 * "512 B", "3 KB", "0,4 MB" is never written: from 1 MB on one decimal at most ("1,2 MB",
 * "300 MB", "1,2 GB"), below it whole KB ("190 KB"), below 1 KB bytes. A small file is
 * never written as "0 MB", and a figure that rounds up to 1024 KB is written as 1 MB. In the
 * viewer's locale.
 */
export function formatSize(
  bytes: number,
  format: ReturnType<typeof useFormatter>,
): string {
  if (bytes >= GB) {
    return `${format.number(bytes / GB, { maximumFractionDigits: 1 })} GB`;
  }
  if (Math.round(bytes / KB) >= 1024) {
    return `${format.number(bytes / MB, { maximumFractionDigits: 1 })} MB`;
  }
  // From 1000 bytes on KB, so "1.000 B" (a thousands dot that reads like a decimal) never shows.
  if (bytes >= 1000) {
    return `${format.number(Math.round(bytes / KB), { maximumFractionDigits: 0 })} KB`;
  }
  return `${format.number(bytes, { maximumFractionDigits: 0 })} B`;
}
