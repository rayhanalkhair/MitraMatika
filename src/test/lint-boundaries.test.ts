import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the relative-import boundary rules in eslint.config.mjs with ESLint's Node API and the
// repo config. The code is linted under the path of an existing file (nothing is written to disk).
const root = process.cwd();
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: join(root, "eslint.config.mjs"),
});

async function restricted(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}

// Full-suite load made a 60 s limit flaky (62-65 s seen); alone these pass well inside it.
const TIMEOUT = 180_000;

describe("relative imports out of a feature", () => {
  it(
    "flags a cross-feature relative import from a service file",
    async () => {
      const messages = await restricted(
        "src/features/auth/service/access.ts",
        'import { x } from "../../generation/service/y";\nexport const z = x;\n',
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("relative path");
    },
    TIMEOUT,
  );

  it(
    "flags it at every folder depth, counting the ../ segments exactly",
    async () => {
      // index.ts sits at the feature root: any `../` leaves the feature.
      expect(
        await restricted(
          "src/features/auth/index.ts",
          'import { x } from "../generation/index";\nexport const z = x;\n',
        ),
      ).toHaveLength(1);
      // ui/ is one folder down: `../../` leaves the feature, `../` does not.
      expect(
        await restricted(
          "src/features/auth/ui/GoogleButton.tsx",
          'import { x } from "../../generation/ui/Y";\nexport const z = x;\n',
        ),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "flags a relative import that climbs out of src/features altogether",
    async () => {
      expect(
        await restricted(
          "src/features/auth/service/access.ts",
          'import { x } from "../../../lib/db/client";\nexport const z = x;\n',
        ),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "allows relative imports that stay inside the feature",
    async () => {
      expect(
        await restricted(
          "src/features/auth/service/access.ts",
          'import { x } from "../schema/types";\nimport { y } from "./profile";\nexport const z = [x, y];\n',
        ),
      ).toEqual([]);
      expect(
        await restricted(
          "src/features/auth/index.ts",
          'export { x } from "./schema/types";\n',
        ),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "keeps the alias rules (another feature's service internals stay banned)",
    async () => {
      const messages = await restricted(
        "src/features/auth/service/access.ts",
        'import { x } from "@/features/generation/service/y";\nexport const z = x;\n',
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("index.ts");
    },
    TIMEOUT,
  );

  it("is written for every folder depth the features use", () => {
    const maxDepth = (dir: string, depth: number): number =>
      readdirSync(dir, { withFileTypes: true }).reduce((deepest, entry) => {
        if (entry.isDirectory()) {
          return Math.max(deepest, maxDepth(join(dir, entry.name), depth + 1));
        }
        return /\.(ts|tsx)$/.test(entry.name) ? Math.max(deepest, depth) : deepest;
      }, 0);
    for (const feature of readdirSync(join(root, "src", "features"))) {
      // Keep in step with MAX_FEATURE_DEPTH in eslint.config.mjs.
      expect(
        maxDepth(join(root, "src", "features", feature), 0),
        feature,
      ).toBeLessThanOrEqual(4);
    }
  });
});

describe("relative imports from src/lib into src/features", () => {
  it(
    "flags ../features from a lib file at any depth",
    async () => {
      expect(
        await restricted(
          "src/lib/result.ts",
          'import { x } from "../features/auth";\nexport const z = x;\n',
        ),
      ).toHaveLength(1);
      expect(
        await restricted(
          "src/lib/jobs/queue.ts",
          'import { x } from "../../features/auth/service/y";\nexport const z = x;\n',
        ),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    "flags it in a composition root too, and still allows lib-relative imports",
    async () => {
      expect(
        await restricted(
          "src/lib/jobs/default.ts",
          'import { x } from "../../features/auth";\nexport const z = x;\n',
        ),
      ).toHaveLength(1);
      expect(
        await restricted(
          "src/lib/jobs/queue.ts",
          'import { x } from "../db/schema";\nexport const z = x;\n',
        ),
      ).toEqual([]);
    },
    TIMEOUT,
  );
});
