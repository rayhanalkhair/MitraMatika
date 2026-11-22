function parseDecimal(text: string): number | null {
  let t = text;
  if (t.includes(",")) {
    // When comma present, validate thousands separator groups or no dots
    if (!(/^-?[1-9]\d{0,2}(\.\d{3})*,\d+$/.test(t) || /^-?\d+,\d+$/.test(t))) {
      return null;
    }
    t = t.replace(/\./g, "").replace(",", ".");
  } else if (/^-?[1-9]\d{0,2}(\.\d{3})+$/.test(t)) {
    // Thousands separator: require non-zero leading digit
    t = t.replace(/\./g, "");
  }
  // Scientific notation (e.g. "1.5625e19") is checked separately from the
  // comma/thousands-separator handling above, since a model writing a very
  // large or small verification value naturally reaches for it — treating
  // it as unsupported would wrongly mark a genuinely correct answer as
  // unverifiable.
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return null;
  return Number(t);
}

export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, "").replace(/−/g, "-");
  if (s === "") return null;

  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1);
  }

  const fraction = /^([^/]+)\/([^/]+)$/.exec(s);
  let value: number | null;
  if (fraction) {
    const numerator = parseDecimal(fraction[1]);
    const denominator = parseDecimal(fraction[2]);
    if (numerator === null || denominator === null || denominator === 0) {
      return null;
    }
    value = numerator / denominator;
  } else {
    value = parseDecimal(s);
  }

  if (value === null) return null;
  return percent ? value / 100 : value;
}

export function numbersEquivalent(a: string, b: string, relTol = 1e-9): boolean {
  const x = parseNumber(a);
  const y = parseNumber(b);
  if (x === null || y === null) return false;
  const scale = Math.max(1, Math.abs(x), Math.abs(y));
  return Math.abs(x - y) <= relTol * scale;
}
