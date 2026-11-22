import { join } from "node:path";
import { ESLint, type Linter } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { formGuards } from "../../eslint.config.mjs";

// Proves the form lint guards in eslint.config.mjs: React Hook Form's `watch()` cannot be memoized
// by the React Compiler, so forms read live values with `useWatch`. The fixtures are linted with
// the guard block alone and a parser without type information (the full type-aware config takes
// about a minute to build its program); a separate check proves the project config applies the
// same block to a client component. Nothing is written to disk.
const root = process.cwd();
const FILE = "src/features/templates/ui/TemplateForm.tsx";

const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.tsx"],
      languageOptions: { parser: tseslint.parser },
      plugins: { "react-hooks": reactHooks as unknown as ESLint.Plugin },
    },
    formGuards,
  ],
});

async function errors(code: string, ruleId: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, FILE) });
  return result.messages
    .filter((m) => m.ruleId === ruleId && m.severity === 2)
    .map((m) => m.message);
}

const component = (...body: string[]) => ['"use client";', ...body, ""].join("\n");

describe("form lint guards", () => {
  it("the project config applies the guard block to client components", async () => {
    const project = new ESLint({
      cwd: root,
      overrideConfigFile: join(root, "eslint.config.mjs"),
    });
    const config = (await project.calculateConfigForFile(
      join(root, FILE),
    )) as Linter.Config;
    expect(config.rules?.["react-hooks/incompatible-library"]).toEqual([2]);
    expect(config.rules?.["no-restricted-syntax"]).toEqual([
      2,
      ...formGuards.rules["no-restricted-syntax"].slice(1),
    ]);
    // Building the full type-aware config is slow under full-suite load.
  }, 180_000);

  it("fails on watch() from useForm (react-hooks/incompatible-library is an error)", async () => {
    const code = component(
      'import { useForm } from "react-hook-form";',
      "export function Sample() {",
      "  const { register, watch } = useForm<{ name: string }>();",
      '  const name = watch("name");',
      '  return <input {...register("name")} title={name} />;',
      "}",
    );
    expect(await errors(code, "react-hooks/incompatible-library")).toHaveLength(1);
  });

  it.each([
    ["form.watch from the shared hook", 'const name: unknown = form.watch("name");'],
    ["destructured from the form", "const { watch } = form;"],
    ["on a named form", 'const name: unknown = templateForm.watch("name");'],
    ["through the hook's result", 'const name: unknown = result.form.watch("name");'],
    [
      "destructured from the shared hook",
      "const { form: { watch } } = useActionForm(props.options);",
    ],
  ])("fails on watch %s", async (_case, line) => {
    const code = component(
      'import { useActionForm } from "@/lib/forms/use-action-form";',
      "export function Sample(props: { options: Parameters<typeof useActionForm>[0] }) {",
      "  const result = useActionForm(props.options);",
      "  const { form } = result;",
      "  const templateForm = form;",
      `  ${line}`,
      "  return <p />;",
      "}",
    );
    const messages = await errors(code, "no-restricted-syntax");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("useWatch");
  });

  it("allows useWatch and unrelated watch properties (fs.watch)", async () => {
    const code = component(
      'import { watch } from "node:fs";',
      'import * as fs from "node:fs";',
      'import { useForm, useWatch } from "react-hook-form";',
      "export function Sample() {",
      "  const { register, control } = useForm<{ name: string }>();",
      '  const name = useWatch({ control, name: "name" });',
      '  fs.watch(".");',
      '  watch(".");',
      '  return <input {...register("name")} title={name} />;',
      "}",
    );
    expect(await errors(code, "react-hooks/incompatible-library")).toEqual([]);
    expect(await errors(code, "no-restricted-syntax")).toEqual([]);
  });
});
