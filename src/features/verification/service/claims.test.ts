import { describe, expect, it } from "vitest";
import { evaluateClaim } from "./claims";

describe("numeric_eval", () => {
  it("passes when the expression equals the expected value", () => {
    const r = evaluateClaim({
      type: "numeric_eval",
      expression: "3^2 + 4^2",
      expected: "25",
    });
    expect(r.status).toBe("pass");
  });

  it("fails on a planted wrong answer", () => {
    const r = evaluateClaim({
      type: "numeric_eval",
      expression: "3^2 + 4^2",
      expected: "24",
    });
    expect(r.status).toBe("fail");
  });

  it("accepts an Indonesian-format expected value", () => {
    const r = evaluateClaim({
      type: "numeric_eval",
      expression: "5 / 2",
      expected: "2,5",
    });
    expect(r.status).toBe("pass");
  });

  it("marks assignments unsupported instead of executing them", () => {
    const r = evaluateClaim({
      type: "numeric_eval",
      expression: "x = 5",
      expected: "5",
    });
    expect(r.status).toBe("unsupported");
  });

  it("marks unparsable expressions unsupported", () => {
    const r = evaluateClaim({
      type: "numeric_eval",
      expression: "3 +* 4",
      expected: "7",
    });
    expect(r.status).toBe("unsupported");
  });
});

describe("expression_equivalent", () => {
  it("passes for equal expressions", () => {
    const r = evaluateClaim({
      type: "expression_equivalent",
      a: "(x + 1)^2",
      b: "x^2 + 2x + 1",
      variables: ["x"],
    });
    expect(r.status).toBe("pass");
  });

  it("fails for different expressions", () => {
    const r = evaluateClaim({
      type: "expression_equivalent",
      a: "(x + 1)^2",
      b: "x^2 + 1",
      variables: ["x"],
    });
    expect(r.status).toBe("fail");
  });

  it("handles two variables", () => {
    const r = evaluateClaim({
      type: "expression_equivalent",
      a: "(a + b)^2 - (a - b)^2",
      b: "4 a b",
      variables: ["a", "b"],
    });
    expect(r.status).toBe("pass");
  });
});

describe("equation_solution", () => {
  it("passes when every claimed solution satisfies the equation", () => {
    const r = evaluateClaim({
      type: "equation_solution",
      equation: "x^2 - 5x + 6 = 0",
      variable: "x",
      solutions: ["2", "3"],
    });
    expect(r.status).toBe("pass");
  });

  it("fails when a claimed solution does not satisfy the equation", () => {
    const r = evaluateClaim({
      type: "equation_solution",
      equation: "x^2 - 5x + 6 = 0",
      variable: "x",
      solutions: ["2", "4"],
    });
    expect(r.status).toBe("fail");
  });

  it("marks an equation without exactly one equals sign unsupported", () => {
    const r = evaluateClaim({
      type: "equation_solution",
      equation: "x^2 - 5x + 6",
      variable: "x",
      solutions: ["2"],
    });
    expect(r.status).toBe("unsupported");
  });
});

describe("choice_matches_answer", () => {
  it("passes when the marked option equals the answer", () => {
    const r = evaluateClaim({
      type: "choice_matches_answer",
      options: ["12", "13", "14", "15"],
      markedIndex: 1,
      answer: "13",
    });
    expect(r.status).toBe("pass");
  });

  it("passes for equivalent forms of the same number", () => {
    const r = evaluateClaim({
      type: "choice_matches_answer",
      options: ["0,25", "0,5", "0,75", "1"],
      markedIndex: 1,
      answer: "1/2",
    });
    expect(r.status).toBe("pass");
  });

  it("fails when the marked option is not the answer", () => {
    const r = evaluateClaim({
      type: "choice_matches_answer",
      options: ["12", "13", "14", "15"],
      markedIndex: 0,
      answer: "13",
    });
    expect(r.status).toBe("fail");
  });

  it("fails on an out-of-range marked index", () => {
    const r = evaluateClaim({
      type: "choice_matches_answer",
      options: ["12", "13"],
      markedIndex: 5,
      answer: "13",
    });
    expect(r.status).toBe("fail");
  });

  it("compares non-numeric answers as normalised text", () => {
    const r = evaluateClaim({
      type: "choice_matches_answer",
      options: ["Segitiga siku-siku", "Segitiga sama sisi"],
      markedIndex: 0,
      answer: "  segitiga   siku-siku ",
    });
    expect(r.status).toBe("pass");
  });
});

describe("equation_solution precision", () => {
  const eq = (equation: string, solutions: string[]) =>
    evaluateClaim({ type: "equation_solution", equation, variable: "x", solutions });

  it("fails a near-miss on a large solution", () => {
    expect(eq("x - 50000 = 0", ["50001"]).status).toBe("fail");
    expect(eq("x = 100000", ["100005"]).status).toBe("fail");
  });

  it("passes the exact large solution", () => {
    expect(eq("x - 50000 = 0", ["50000"]).status).toBe("pass");
  });

  it("passes decimal and fraction solutions", () => {
    expect(eq("2x = 5", ["2,5"]).status).toBe("pass");
    expect(eq("3x = 1", ["1/3"]).status).toBe("pass");
  });
});

describe("expression safety allowlist", () => {
  const num = (expression: string, expected = "1") =>
    evaluateClaim({ type: "numeric_eval", expression, expected });

  it("rejects state-mutating and resource-heavy calls", () => {
    expect(num("createUnit('u')").status).toBe("unsupported");
    expect(num("zeros(10000,10000)", "0").status).toBe("unsupported");
    expect(num("1:1e9", "0").status).toBe("unsupported");
    expect(num("evaluate('y=5')", "5").status).toBe("unsupported");
  });

  it("rejects accessors, string constants, unknown symbols, and long input", () => {
    expect(num("a.b").status).toBe("unsupported");
    expect(num('x["constructor"]').status).toBe("unsupported");
    expect(num('"abc"').status).toBe("unsupported");
    expect(num("y + 1", "2").status).toBe("unsupported");
    expect(num("1+".repeat(150) + "1", "151").status).toBe("unsupported");
  });

  it("rejects units and does not leak state from createUnit", () => {
    num("createUnit('foo')");
    expect(num("2 foo", "2").status).toBe("unsupported");
    expect(num("5 cm", "5").status).toBe("unsupported");
    expect(num("sqrt(16) + pi - pi", "4").status).toBe("pass");
  });
});

describe("expression_equivalent sampling", () => {
  const eqv = (a: string, b: string, variables: string[]) =>
    evaluateClaim({ type: "expression_equivalent", a, b, variables });

  it("fails multivariable expressions that only agree on a line", () => {
    expect(eqv("b - a", "0.37", ["a", "b"]).status).toBe("fail");
    expect(eqv("a*b", "a^2 + 0.37*a", ["a", "b"]).status).toBe("fail");
    expect(eqv("a + b", "2*a + 0.37", ["a", "b"]).status).toBe("fail");
    expect(eqv("a^2 + b^2", "2*a^2 + 0.74*a + 0.1369", ["a", "b"]).status).toBe("fail");
    expect(eqv("a + b + c", "3*a + 1.11", ["a", "b", "c"]).status).toBe("fail");
  });

  it("fails single-variable expressions that agree on fixed points", () => {
    expect(eqv("x", "x + sin(2*pi*x)", ["x"]).status).toBe("fail");
    expect(
      eqv("0", "(x+3)*(x+2)*(x+1)*(x-0.5)*(x-1)*(x-2)*(x-3)*(x-7)", ["x"]).status,
    ).toBe("fail");
  });

  it("still supports domain-restricted functions", () => {
    expect(eqv("sqrt(x^2)", "abs(x)", ["x"]).status).toBe("pass");
    expect(eqv("log(x*y)", "log(x) + log(y)", ["x", "y"]).status).toBe("pass");
  });

  it("is deterministic", () => {
    const first = eqv("(a + b)^2", "a^2 + 2ab + b^2", ["a", "b"]);
    const second = eqv("(a + b)^2", "a^2 + 2ab + b^2", ["a", "b"]);
    expect(first.detail).toBe(second.detail);
  });
});

describe("equation_solution tolerance scales with the solution", () => {
  const eq = (equation: string, solutions: string[]) =>
    evaluateClaim({ type: "equation_solution", equation, variable: "x", solutions });

  it("fails small errors hidden by large side values", () => {
    expect(eq("x + 10000000000 = 10000000001", ["2"]).status).toBe("fail");
    expect(eq("x + 1000000 = 1000001", ["1,0001"]).status).toBe("fail");
    expect(eq("1000000 x = 2000000", ["2,0000000001"]).status).toBe("fail");
  });
});

describe("choice_matches_answer mixed numeric and text", () => {
  const choice = (options: string[], markedIndex: number, answer: string) =>
    evaluateClaim({ type: "choice_matches_answer", options, markedIndex, answer });

  it("is unsupported when only one side is numeric", () => {
    expect(choice(["12 cm", "13 cm", "14 cm"], 1, "13").status).toBe("unsupported");
    expect(choice(["Rp15.000", "Rp20.000"], 0, "15000").status).toBe("unsupported");
    expect(choice(["x = 4", "x = 5"], 0, "4").status).toBe("unsupported");
  });
});
