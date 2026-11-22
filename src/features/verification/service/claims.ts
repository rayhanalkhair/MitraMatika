import { parse, type MathNode } from "mathjs";
import { compareAnswers } from "./compare-answers";
import { parseNumber } from "./number";

export type Claim =
  | { type: "numeric_eval"; expression: string; expected: string }
  | { type: "expression_equivalent"; a: string; b: string; variables: string[] }
  | {
      type: "equation_solution";
      equation: string;
      variable: string;
      solutions: string[];
    }
  | {
      type: "choice_matches_answer";
      options: string[];
      markedIndex: number;
      answer: string;
    };

export interface ClaimResult {
  claim: Claim;
  status: "pass" | "fail" | "unsupported";
  detail: string;
}

class UnsupportedError extends Error {}

const N_SAMPLES = 24;
const MIN_VALID_SAMPLES = 4;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_EXPRESSION_LENGTH = 200;
const ALLOWED_CONSTANTS = ["pi", "e"];
const ALLOWED_FUNCTIONS = new Set([
  "sqrt",
  "cbrt",
  "abs",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "log",
  "log10",
  "log2",
  "exp",
  "floor",
  "ceil",
  "round",
  "min",
  "max",
  "pow",
  "nthRoot",
  "mod",
  "gcd",
  "lcm",
  "factorial",
]);
const ALLOWED_OPERATORS = new Set(["+", "-", "*", "/", "^", "%"]);

function reject(what: string): never {
  throw new UnsupportedError(`${what} tidak diizinkan dalam ekspresi.`);
}

function checkNode(node: MathNode, allowedNames: Set<string>): void {
  switch (node.type) {
    case "ConstantNode":
      if (typeof (node as unknown as { value: unknown }).value !== "number") {
        reject("Konstanta non-numerik");
      }
      return;
    case "SymbolNode": {
      const name = (node as unknown as { name: string }).name;
      if (!allowedNames.has(name)) reject(`Simbol "${name}"`);
      return;
    }
    case "ParenthesisNode":
      checkNode((node as unknown as { content: MathNode }).content, allowedNames);
      return;
    case "OperatorNode": {
      const op = node as unknown as { op: string; args: MathNode[] };
      if (!ALLOWED_OPERATORS.has(op.op)) reject(`Operator "${op.op}"`);
      op.args.forEach((arg) => {
        checkNode(arg, allowedNames);
      });
      return;
    }
    case "FunctionNode": {
      const fn = node as unknown as { fn: MathNode; args: MathNode[] };
      const callee = fn.fn as unknown as { type: string; name?: string };
      if (
        callee.type !== "SymbolNode" ||
        callee.name === undefined ||
        !ALLOWED_FUNCTIONS.has(callee.name)
      ) {
        reject(`Fungsi "${callee.name ?? "?"}"`);
      }
      fn.args.forEach((arg) => {
        checkNode(arg, allowedNames);
      });
      return;
    }
    case "AssignmentNode":
    case "FunctionAssignmentNode":
      throw new UnsupportedError("Penugasan tidak diizinkan dalam ekspresi.");
    default:
      reject(`Bentuk ekspresi ${node.type}`);
  }
}

function safeParse(expression: string, allowedVariables: string[] = []): MathNode {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new UnsupportedError("Ekspresi terlalu panjang.");
  }
  let node: MathNode;
  try {
    node = parse(expression);
  } catch {
    throw new UnsupportedError(`Ekspresi tidak dapat dibaca: ${expression}`);
  }
  checkNode(node, new Set([...ALLOWED_CONSTANTS, ...allowedVariables]));
  return node;
}

function evalNumber(node: MathNode, scope: Record<string, number> = {}): number {
  let value: unknown;
  try {
    value = node.evaluate(scope);
  } catch (error) {
    throw new UnsupportedError(
      error instanceof Error ? error.message : "Ekspresi gagal dihitung.",
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UnsupportedError("Hasil bukan bilangan riil yang terhingga.");
  }
  return value;
}

function close(x: number, y: number, relTol = 1e-9): boolean {
  return Math.abs(x - y) <= relTol * Math.max(1, Math.abs(x), Math.abs(y));
}

function evaluateNumericEval(claim: Extract<Claim, { type: "numeric_eval" }>) {
  const expected = parseNumber(claim.expected);
  if (expected === null) {
    throw new UnsupportedError(`Nilai yang diharapkan bukan bilangan: ${claim.expected}`);
  }
  const value = evalNumber(safeParse(claim.expression));
  return close(value, expected)
    ? { status: "pass" as const, detail: `${claim.expression} = ${String(value)}` }
    : {
        status: "fail" as const,
        detail: `${claim.expression} = ${String(value)}, bukan ${claim.expected}`,
      };
}

function evaluateEquivalent(claim: Extract<Claim, { type: "expression_equivalent" }>) {
  const a = safeParse(claim.a, claim.variables).compile();
  const b = safeParse(claim.b, claim.variables).compile();
  let valid = 0;
  const seed = fnv1a(`${claim.a}|${claim.b}|${claim.variables.join(",")}`);
  const random = mulberry32(seed);
  for (let point = 0; point < N_SAMPLES; point += 1) {
    const scope: Record<string, number> = {};
    for (const name of claim.variables) {
      scope[name] = point % 2 === 0 ? -10 + 20 * random() : 0.1 + 9.9 * random();
    }
    let x: unknown;
    let y: unknown;
    try {
      x = a.evaluate(scope);
      y = b.evaluate(scope);
    } catch {
      continue;
    }
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      continue;
    }
    valid += 1;
    if (!close(x, y, 1e-8)) {
      return {
        status: "fail" as const,
        detail: `Berbeda pada ${JSON.stringify(scope)}: ${String(x)} vs ${String(y)}`,
      };
    }
  }
  if (valid < MIN_VALID_SAMPLES) {
    throw new UnsupportedError("Titik uji yang valid terlalu sedikit.");
  }
  return {
    status: "pass" as const,
    detail: `Sama pada ${String(valid)} titik uji (seed ${String(seed)}).`,
  };
}

function evaluateEquationSolution(claim: Extract<Claim, { type: "equation_solution" }>) {
  const sides = claim.equation.split("=");
  if (sides.length !== 2) {
    throw new UnsupportedError("Persamaan harus memuat tepat satu tanda sama dengan.");
  }
  const lhsNode = safeParse(sides[0], [claim.variable]);
  const rhsNode = safeParse(sides[1], [claim.variable]);
  for (const raw of claim.solutions) {
    const solution = parseNumber(raw);
    if (solution === null) {
      throw new UnsupportedError(`Penyelesaian bukan bilangan: ${raw}`);
    }
    const scope = { [claim.variable]: solution };
    const lhs = evalNumber(lhsNode, scope);
    const rhs = evalNumber(rhsNode, scope);
    if (Math.abs(lhs - rhs) > 1e-9 * Math.max(1, Math.abs(solution))) {
      return {
        status: "fail" as const,
        detail: `${claim.variable} = ${raw} tidak memenuhi persamaan (${String(lhs)} vs ${String(rhs)}).`,
      };
    }
  }
  return { status: "pass" as const, detail: "Semua penyelesaian memenuhi persamaan." };
}

function evaluateChoice(claim: Extract<Claim, { type: "choice_matches_answer" }>) {
  const marked = claim.options.at(claim.markedIndex);
  if (marked === undefined) {
    return { status: "fail" as const, detail: "Indeks pilihan di luar rentang." };
  }
  const verdict = compareAnswers(marked, claim.answer);
  if (verdict === "incomparable") {
    throw new UnsupportedError(
      "Pilihan dan jawaban tidak dapat dibandingkan secara otomatis (satu berupa angka, satu bukan).",
    );
  }
  return verdict === "match"
    ? { status: "pass" as const, detail: "Pilihan yang ditandai sama dengan jawaban." }
    : {
        status: "fail" as const,
        detail: `Pilihan yang ditandai (${marked}) tidak sama dengan jawaban (${claim.answer}).`,
      };
}

export function evaluateClaim(claim: Claim): ClaimResult {
  try {
    switch (claim.type) {
      case "numeric_eval":
        return { claim, ...evaluateNumericEval(claim) };
      case "expression_equivalent":
        return { claim, ...evaluateEquivalent(claim) };
      case "equation_solution":
        return { claim, ...evaluateEquationSolution(claim) };
      case "choice_matches_answer":
        return { claim, ...evaluateChoice(claim) };
    }
  } catch (error) {
    if (error instanceof UnsupportedError) {
      return { claim, status: "unsupported", detail: error.message };
    }
    throw error;
  }
}
