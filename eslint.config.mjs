import { readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettierConfig from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const features = readdirSync(path.join(import.meta.dirname, "src/features"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const legacyAliases = {
  group: ["@/modules", "@/modules/**", "@/platform", "@/platform/**"],
  message: "src/modules and src/platform were replaced by src/features and src/lib.",
};

// Deepest folder nesting (below a feature root) the relative-import rule is written for. A file
// deeper than this would need another entry; the structure test fails if one appears.
const MAX_FEATURE_DEPTH = 4;

// Relative imports that leave the feature folder: from a file `depth` folders below the feature
// root, `depth + 1` leading `../` segments land outside it (in another feature, in src/features
// or above). The `@/features/...` alias patterns cannot see these, so they would bypass the rules.
function leavesFeature(depth) {
  return {
    group: [`${"../".repeat(depth + 1)}**`],
    message:
      "A feature may not import across its folder with a relative path. Use the @/features/<name> index, or @/lib/... for shared code.",
  };
}

// Relative imports from src/lib into src/features (`../features`, `../../features/x`, ...).
const libToFeaturesRelative = {
  group: ["../**/features", "../**/features/**"],
  message: "src/lib must not import src/features (adapters sit below features).",
};

// Patterns for another feature's internals; `own` (a feature name) is exempted.
function featureInternals(own) {
  return {
    group: [
      "@/features/*/service",
      "@/features/*/service/**",
      "@/features/*/schema",
      "@/features/*/schema/**",
      ...(own ? [`!@/features/${own}/**`] : []),
    ],
    message:
      "Import another feature through its index.ts (or its ui/ and actions/ files), not its service/ or schema/ internals.",
  };
}

// React Hook Form's `watch()` cannot be memoized safely, so forms read live values with `useWatch`.
// Names an RHF form object: `form`, `xForm`, or the `form` of the shared hook's result.
const RHF_FORM = "/^(form|[a-zA-Z]+Form)$/";
const NO_WATCH = "Read live form values with useWatch (react-hook-form), not watch().";

/**
 * Forms (stack alignment, Task 5). The react-hooks rule only sees `useForm()` called in the same
 * component; the syntax ban also catches `watch` on a form object (`form.watch`, `x.form.watch`,
 * `const { watch } = form`, `const { form: { watch } } = useActionForm(...)`). Unrelated `watch`
 * properties (`fs.watch`) stay allowed. Exported for the lint guard test.
 *
 * @satisfies {import("eslint").Linter.Config}
 */
export const formGuards = {
  files: ["src/**/*.{ts,tsx}"],
  rules: {
    "react-hooks/incompatible-library": "error",
    "no-restricted-syntax": [
      "error",
      {
        selector: `MemberExpression[property.name="watch"][object.name=${RHF_FORM}]`,
        message: NO_WATCH,
      },
      {
        selector: `MemberExpression[property.name="watch"][object.property.name=${RHF_FORM}]`,
        message: NO_WATCH,
      },
      {
        selector: `VariableDeclarator[init.name=${RHF_FORM}] > ObjectPattern > Property[key.name="watch"]`,
        message: NO_WATCH,
      },
      {
        selector: `VariableDeclarator[init.callee.name=/^use(Action)?Form$/] Property[key.name="watch"]`,
        message: NO_WATCH,
      },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next already registers the next, react-hooks and jsx-a11y plugins;
  // only the missing rule sets are layered on here (a duplicate plugin name errors).
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  formGuards,
  {
    // Test-only pattern: `rows[0]!` / `expect(x!)` after a length assertion is how
    // tests narrow fixtures; a thrown TypeError is the intended failure there.
    files: ["**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  // Module boundaries (stack-migration stage 2). `no-restricted-imports` replaces rather than merges
  // per file, so every block below repeats the legacy-alias ban.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: { "no-restricted-imports": ["error", { patterns: [legacyAliases] }] },
  },
  {
    // Another feature or the routes may reach a feature only through its `index.ts`, its `ui/`
    // files or its `actions/` files (Server Actions), never its `service/` or `schema/` internals.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [legacyAliases, featureInternals()] },
      ],
    },
  },
  ...features.flatMap((feature) =>
    // A feature may use its own internals freely, but only through paths that stay inside its
    // folder: one block per folder depth, so `../` counts are exact (the later block wins).
    Array.from({ length: MAX_FEATURE_DEPTH + 1 }, (_, depth) => ({
      files: [`src/features/${feature}/${"*/".repeat(depth)}*.{ts,tsx}`],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [legacyAliases, featureInternals(feature), leavesFeature(depth)] },
        ],
      },
    })),
  ),
  {
    // Features form a layered graph: a cycle through the index files only works while every
    // imported binding is used inside a function. Type-only imports are erased and do not count.
    files: ["src/features/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "import/no-cycle": ["error", { maxDepth: 4, ignoreExternal: true }],
    },
  },
  {
    // Known, older cycle through the fake-AI composition root (src/lib/ai/e2e/scenarios replays
    // generation fixtures); it is not a feature-to-feature edge.
    files: [
      "src/features/generation/index.ts",
      "src/features/generation/service/register.ts",
    ],
    rules: { "import/no-cycle": "off" },
  },
  {
    // `src/lib` holds adapters and must not depend on features.
    files: ["src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            legacyAliases,
            {
              group: ["@/features", "@/features/**"],
              message:
                "src/lib must not import src/features (adapters sit below features).",
            },
            libToFeaturesRelative,
          ],
        },
      ],
    },
  },
  {
    // Composition roots: the only src/lib files that wire features in (job handlers, fake-AI
    // scripts that replay generation fixtures, the AI smoke CLI). They may import a feature,
    // but only through its `@/features/<name>` index.
    files: [
      "src/lib/jobs/default.ts",
      "src/lib/ai/e2e/scenarios.ts",
      "src/lib/ai/smoke.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            legacyAliases,
            {
              group: ["@/features/*/**"],
              message: "Composition roots import a feature only through its index.ts.",
            },
            libToFeaturesRelative,
          ],
        },
      ],
    },
  },
  prettierConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Other tools' git worktrees can end up nested inside this directory
    // (e.g. .kilo/worktrees/<name>/) — never lint another checkout's files.
    ".kilo/**",
    // Untracked local spike output (gitignored), not part of the project.
    ".spikes-output/**",
    // Generated base64 font modules (scripts/generate-pdf-fonts.mjs), up to 4 MB of string literals.
    "src/features/export/assets/fonts/*.generated.ts",
  ]),
]);

export default eslintConfig;
