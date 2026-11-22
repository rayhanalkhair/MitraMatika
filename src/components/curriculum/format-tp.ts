// Normalises a learning-objective code to "TP-…". Codes arrive with or without a "TP" prefix and the
// display layer used to add its own label, which produced "TP TP-08-GEO-01".
export function formatTP(code: string): string {
  const rest = code.trim().replace(/^(?:tp[\s-]*)+/i, "");
  return `TP-${rest}`;
}
