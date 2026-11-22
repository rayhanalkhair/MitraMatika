import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf-8");

describe("globals.css theme tokens", () => {
  it("defines the shadcn/ui theme token set under :root", () => {
    for (const token of [
      "--background",
      "--foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--muted",
      "--accent",
      "--border",
      "--ring",
      "--radius",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("has no dark-mode block (light-only theme, spec decision 1)", () => {
    expect(css).not.toContain("prefers-color-scheme: dark");
  });

  it("scopes the dark variant to a .dark class instead of the OS media query", () => {
    expect(css).toContain("@custom-variant dark (&:is(.dark *));");
  });

  it("defines the ai token set", () => {
    for (const token of ["--ai:", "--ai-soft:", "--ai-foreground:", "--color-ai:"]) {
      expect(css).toContain(token);
    }
  });

  it("uses Manrope and Plus Jakarta Sans and no Geist", () => {
    const layout = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf-8");
    expect(layout).toContain("Manrope");
    expect(layout).toContain("Plus_Jakarta_Sans");
    expect(layout).not.toContain("Geist");
    expect(css).not.toContain("geist");
  });

  it("makes rounded-xl exactly 12px", () => {
    expect(css).toMatch(/--radius-xl:\s*0\.75rem;/);
  });

  describe("contrast", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("@layer base"));
    const token = (name: string): string => {
      const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root);
      if (!m) throw new Error(`token ${name} must be a 6-digit hex in :root`);
      return m[1];
    };
    const channel = (v: number) =>
      v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) =>
        channel(parseInt(hex.slice(i, i + 2), 16) / 255),
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    it.each(["success", "warning", "destructive", "ai"])(
      "every status foreground meets 4.5:1 on its soft background (%s)",
      (name) => {
        expect(
          ratio(token(`--${name}-foreground`), token(`--${name}-soft`)),
        ).toBeGreaterThanOrEqual(4.5);
      },
    );

    it("primary-foreground meets 4.5:1 on the primary hover colour", () => {
      expect(
        ratio(token("--primary-foreground"), token("--primary-hover")),
      ).toBeGreaterThanOrEqual(4.5);
      expect(css).toContain("--color-primary-hover: var(--primary-hover);");
    });

    it("primary-foreground meets 4.5:1 on primary", () => {
      expect(
        ratio(token("--primary-foreground"), token("--primary")),
      ).toBeGreaterThanOrEqual(4.5);
    });
  });
});
