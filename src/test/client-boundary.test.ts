import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkClientBoundary, type SourceMap } from "./client-boundary-check";

const ROOT = path.resolve(import.meta.dirname, "../..");

function loadSources(dir: string, into: SourceMap = {}): SourceMap {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) loadSources(full, into);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      into[path.relative(ROOT, full).split(path.sep).join("/")] = readFileSync(
        full,
        "utf8",
      );
    }
  }
  return into;
}

// The app shell as commit 063f715 shipped it: a Server Component (no "use client"), so Sidebar and
// BottomNav rendered NavItem on the server and handed it Lucide icon components. Kept as a fixture
// because CI clones shallowly, so the test cannot read git history.
const PRE_FIX_APP_SHELL = `import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations("shell");
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-sm focus:ring-2 focus:ring-ring"
      >
        {t("skipToContent")}
      </a>
      <Sidebar />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-w-0 flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] outline-none md:pb-0"
      >
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
`;

describe("server-to-client prop boundary", () => {
  it("passes only serialisable props from Server Components to Client Components", () => {
    expect(checkClientBoundary(loadSources(path.join(ROOT, "src")))).toEqual([]);
  });

  it("catches the pre-fix app shell (Lucide icons handed from server components to NavItem)", () => {
    const files = loadSources(path.join(ROOT, "src"));
    // Commit 063f715 shipped AppShell as a Server Component; the dev server rejected that.
    files["src/components/shell/AppShell.tsx"] = PRE_FIX_APP_SHELL;
    const found = checkClientBoundary(files);
    expect(found.map((v) => `${v.file} <${v.component} ${v.prop}>`).sort()).toEqual([
      "src/components/shell/BottomNav.tsx <NavItem item>",
      "src/components/shell/Sidebar.tsx <NavItem item>",
    ]);
  });

  describe("on inline sources", () => {
    const client = '"use client";\nexport function Chip(_: object) { return null; }\n';
    const run = (server: string, extra: SourceMap = {}) =>
      checkClientBoundary({ "src/Chip.tsx": client, "src/Page.tsx": server, ...extra });

    it("flags an imported icon, an inline function and a class instance", () => {
      const server = `import { Home } from "lucide-react";
import { Chip } from "./Chip";
export const A = () => <Chip icon={Home} onClick={() => 1} created={new Map()} />;`;
      expect(run(server).map((v) => v.prop)).toEqual(["icon", "onClick", "created"]);
    });

    it("allows Server Actions on action and formAction, and plain data", () => {
      const server = `import { Chip } from "./Chip";
import { doIt } from "./actions";
export const A = () => <Chip action={doIt} formAction={async () => {}} label="x" n={1} list={[1, "a"]} />;`;
      expect(
        run(server, { "src/actions.ts": "export async function doIt() {}" }),
      ).toEqual([]);
    });

    it("flags a map over data imported from a module of icons", () => {
      const server = `import { Chip } from "./Chip";
import { items } from "./items";
export const A = () => <>{items.map((item) => <Chip key={item.id} item={item} />)}</>;`;
      const items = `import { Home } from "lucide-react";\nexport const items = [{ id: 1, icon: Home }];`;
      expect(run(server, { "src/items.ts": items }).map((v) => v.prop)).toEqual(["item"]);
    });

    it("ignores a file that a client module imports (it is client-side then)", () => {
      const server = `import { Home } from "lucide-react";
import { Chip } from "./Chip";
export const A = () => <Chip icon={Home} />;`;
      const parent = '"use client";\nimport { A } from "./Page";\nexport const B = A;';
      expect(run(server, { "src/Parent.tsx": parent })).toEqual([]);
    });
  });
});
