// Indonesian writes a decimal comma (`9,60`), but KaTeX treats a bare comma in math as a list
// separator and adds a thin space after it, so `$9,60$` reads as two numbers. KaTeX's own fix is to
// wrap the comma in a group: `9{,}60`. This is display only; the stored text is never changed.
//
// A comma with a digit on both sides is a decimal comma, and is rewritten, unless it is in a LIST
// context or part of a chain of numbers (`2,4,6,8`, `1,234,567`). A comma followed by a space
// (`A(2, 3)`) is never touched. List contexts are:
//   - `(...)` and `[...]` that look like an argument list or a pair: the content has a letter or a
//     command such as `\pi` (`f(2,3)`, `(x,y)`), has three or more numbers, or is exactly two
//     numbers (`(3,4)`, `[1,5]`, `(0,5)`: a point, an interval or a decimal, so left as written)
//     unless the group is followed by `\%`, `^` or an operator (`(12,5)\%`);
//     any other group, such as `(1,5+2)` or `[2,5+1]`, is arithmetic and its commas are decimal;
//   - `\{...\}`, `\lbrace`, `\langle` (sets and tuples);
//   - `{...}` right after `_` (`a_{1,2}`), the two arguments of `\binom`, and the rows of
//     `\begin{...}`...`\end{...}`.
// `\lfloor`/`\lceil` groups, `^{...}`, `\frac`, `\sqrt` and other braces are decimal contexts.
// `\left`, `\right` (including `\right.`) and `\text{...}`/`\mathrm{...}` bodies are handled
// explicitly: text bodies are copied through untouched, so a `)` in them cannot close a group.

type Kind =
  | "open"
  | "close"
  | "bopen"
  | "bclose"
  | "comma"
  | "sub"
  | "binom"
  | "begin"
  | "end"
  | "raw";
interface Token {
  kind: Kind;
  text: string;
  open?: "list" | "decimal";
}

const TEXT_COMMANDS = new Set([
  "text",
  "textrm",
  "textbf",
  "textit",
  "mathrm",
  "mathbf",
  "mathit",
  "mbox",
  "operatorname",
]);
const OPEN_LIST = new Set(["lbrace", "langle"]);
const CLOSE_LIST = new Set(["rbrace", "rangle"]);
const OPEN_DECIMAL = new Set(["lfloor", "lceil"]);
const CLOSE_DECIMAL = new Set(["rfloor", "rceil"]);
const BINOM = new Set(["binom", "dbinom", "tbinom"]);

// Past this many tokens in one group, do not analyse it: treat it as a list (left as written).
const MAX_GROUP = 10_000;

// The end (exclusive) of the balanced `{...}` body starting at `start` (which holds `{`).
function bodyEnd(math: string, start: number): number {
  let depth = 0;
  for (let i = start; i < math.length; i++) {
    const ch = math[i];
    if (ch === "\\") i++;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return math.length;
}

function tokenize(math: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < math.length) {
    const ch = math[i] ?? "";
    if (ch === "\\") {
      const name = /^[A-Za-z]+/.exec(math.slice(i + 1, i + 40))?.[0];
      if (name === undefined) {
        const next = math[i + 1] ?? "";
        if (next === "{") tokens.push({ kind: "open", text: "\\{", open: "list" });
        else if (next === "}") tokens.push({ kind: "close", text: "\\}" });
        else tokens.push({ kind: "raw", text: ch + next });
        i += 2;
        continue;
      }
      const end = i + 1 + name.length;
      if ((name === "left" || name === "right") && math[end] === ".") {
        // `\left.` / `\right.`: an invisible delimiter that still opens or closes a group.
        if (name === "left")
          tokens.push({ kind: "open", text: "\\left.", open: "decimal" });
        else tokens.push({ kind: "close", text: "\\right." });
        i = end + 1;
      } else if (TEXT_COMMANDS.has(name)) {
        let brace = end;
        while (math[brace] === " ") brace++;
        const stop = math[brace] === "{" ? bodyEnd(math, brace) : end;
        tokens.push({ kind: "raw", text: math.slice(i, stop) });
        i = stop;
      } else if (name === "begin" || name === "end") {
        const stop = math[end] === "{" ? bodyEnd(math, end) : end;
        tokens.push({ kind: name, text: math.slice(i, stop) });
        i = stop;
      } else if (OPEN_LIST.has(name)) {
        tokens.push({ kind: "open", text: `\\${name}`, open: "list" });
        i = end;
      } else if (OPEN_DECIMAL.has(name)) {
        tokens.push({ kind: "open", text: `\\${name}`, open: "decimal" });
        i = end;
      } else if (CLOSE_LIST.has(name) || CLOSE_DECIMAL.has(name)) {
        tokens.push({ kind: "close", text: `\\${name}` });
        i = end;
      } else if (BINOM.has(name)) {
        tokens.push({ kind: "binom", text: `\\${name}` });
        i = end;
      } else {
        tokens.push({ kind: "raw", text: `\\${name}` });
        i = end;
      }
      continue;
    }
    i++;
    if (ch === "(" || ch === "[") tokens.push({ kind: "open", text: ch });
    else if (ch === ")" || ch === "]") tokens.push({ kind: "close", text: ch });
    else if (ch === "{") tokens.push({ kind: "bopen", text: ch });
    else if (ch === "}") tokens.push({ kind: "bclose", text: ch });
    else if (ch === ",") tokens.push({ kind: "comma", text: ch });
    else if (ch === "_") tokens.push({ kind: "sub", text: ch });
    else tokens.push({ kind: "raw", text: ch });
  }
  return tokens;
}

const PURE_NUMBERS = /^\s*[-+]?[\d.]+(,\s*[-+]?[\d.]+)+\s*$/;
const FOLLOWED_BY_OPERATOR = /^\s*(\\%|\\times|\\cdot|\\div|[-+*/^])/;
// Text bodies and spacing/operator commands do not make a group an argument list.
const NEUTRAL =
  /\\(?:text|textrm|textbf|textit|mathrm|mathbf|mathit|mbox|operatorname)\s*\{[^{}]*\}|\\(?:times|cdot|div|pm|mp|quad|qquad|left|right|%)|\\[,;:! ]/g;

// Whether the commas of a `(...)` or `[...]` group are list separators.
function isListGroup(raw: string, after: string): boolean {
  const content = raw.replace(/\\(?:left|right)/g, "");
  const rest = content.replace(NEUTRAL, " ");
  if (/[A-Za-z]|\\[A-Za-z]/.test(rest)) return true; // `f(2,3)`, `(x,y)`, `(1,\pi)`
  if (!PURE_NUMBERS.test(content)) return false; // arithmetic such as `(1,5+2)`
  if (content.split(",").length > 2) return true; // three or more numbers
  return !FOLLOWED_BY_OPERATOR.test(after); // a bare pair is ambiguous unless `(12,5)\%`
}

const isDigitToken = (t: Token | undefined) =>
  t?.kind === "raw" && t.text.length === 1 && t.text >= "0" && t.text <= "9";
const isNumberToken = (t: Token | undefined) =>
  isDigitToken(t) || (t?.kind === "raw" && t.text === ".");

// `1,2,3`: the digits before the comma are preceded by another comma, or the digits after it are
// followed by another comma and a digit.
function isChain(tokens: Token[], comma: number): boolean {
  let before = comma - 1;
  while (before >= 0 && isNumberToken(tokens[before])) before--;
  let after = comma + 1;
  while (after < tokens.length && isNumberToken(tokens[after])) after++;
  return (
    (tokens[before]?.kind === "comma" && isDigitToken(tokens[before - 1])) ||
    (tokens[after]?.kind === "comma" && isDigitToken(tokens[after + 1]))
  );
}

export function withDecimalComma(math: string): string {
  if (!math.includes(",")) return math;
  const tokens = tokenize(math);

  // Match every open token with its close in one pass.
  const matchOf = new Map<number, number>();
  const openStack: number[] = [];
  tokens.forEach((t, i) => {
    if (t.kind === "open") openStack.push(i);
    else if (t.kind === "close") {
      const o = openStack.pop();
      if (o !== undefined) matchOf.set(o, i);
    }
  });

  const contexts: ("list" | "decimal")[] = [];
  let binomArgs = 0;
  let previous: Token | undefined;
  let out = "";
  tokens.forEach((t, i) => {
    switch (t.kind) {
      case "open": {
        let ctx = t.open;
        if (ctx === undefined) {
          const close = matchOf.get(i) ?? tokens.length;
          if (close - i > MAX_GROUP) ctx = "list";
          else {
            const content = tokens
              .slice(i + 1, close)
              .map((x) => x.text)
              .join("");
            const after = tokens
              .slice(close + 1, close + 4)
              .map((x) => x.text)
              .join("");
            ctx = isListGroup(content, after) ? "list" : "decimal";
          }
        }
        contexts.push(ctx);
        break;
      }
      case "close":
      case "end":
        contexts.pop();
        break;
      case "begin":
        contexts.push("list");
        break;
      case "bopen":
        if (previous?.kind === "sub" || binomArgs > 0) {
          contexts.push("list");
          if (binomArgs > 0) binomArgs--;
        } else contexts.push("decimal");
        break;
      case "bclose":
        contexts.pop();
        break;
      case "binom":
        binomArgs = 2;
        break;
      case "comma":
        if (
          isDigitToken(tokens[i - 1]) &&
          isDigitToken(tokens[i + 1]) &&
          contexts[contexts.length - 1] !== "list" &&
          !isChain(tokens, i)
        ) {
          out += "{,}";
          previous = t;
          return;
        }
        break;
      default:
    }
    out += t.text;
    previous = t;
  });
  return out;
}
