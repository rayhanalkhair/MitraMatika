import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEED_FILE,
  describeTarget,
  formatResult,
  parseSeedArgs,
} from "./seed-cli";
import type { WriteSeedResult } from "./seed-writer";

describe("parseSeedArgs", () => {
  it("uses the Grade 8 file and no flags by default", () => {
    expect(parseSeedArgs([])).toEqual({
      ok: true,
      data: { file: DEFAULT_SEED_FILE, activate: false, dryRun: false },
    });
  });

  it("reads each flag", () => {
    expect(parseSeedArgs(["--activate"])).toMatchObject({
      ok: true,
      data: { activate: true },
    });
    expect(parseSeedArgs(["--dry-run"])).toMatchObject({
      ok: true,
      data: { dryRun: true },
    });
    expect(parseSeedArgs(["--file", "data/x.json"])).toMatchObject({
      ok: true,
      data: { file: "data/x.json" },
    });
  });

  it("accepts flags in any order", () => {
    expect(parseSeedArgs(["--file", "a.json", "--dry-run"])).toMatchObject({
      ok: true,
      data: { file: "a.json", dryRun: true },
    });
  });

  it.each([
    [["--file"], /--file/],
    [["--file", "--activate"], /--file/],
    [["--bogus"], /--bogus/],
    [["positional"], /positional/],
    [["--activate", "--dry-run"], /--dry-run/],
  ])("rejects %j with a usage message", (argv, pattern) => {
    const result = parseSeedArgs(argv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(pattern);
  });
});

describe("describeTarget", () => {
  it("shows host and database only, never credentials", () => {
    const text = describeTarget(
      "postgresql://postgres.abc:s3cret@ep-x-pooler.ap-southeast-1.aws.neon.tech:5432/postgres",
    );
    expect(text).toContain("ep-x-pooler.ap-southeast-1.aws.neon.tech");
    expect(text).toContain("postgres");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("postgres.abc");
  });

  it("does not leak anything for an unparsable URL", () => {
    const text = describeTarget("not a url with s3cret");
    expect(text).not.toContain("s3cret");
  });
});

const result = (over: Partial<WriteSeedResult> = {}): WriteSeedResult => ({
  versionCode: "kurikulum-merdeka-fase-d-2025",
  versionStatus: "draft",
  created: { versions: 1, elements: 5, topics: 8, objectives: 16 },
  updated: { versions: 0, elements: 0, topics: 0, objectives: 0 },
  deleted: { versions: 0, elements: 0, topics: 0, objectives: 0 },
  activated: false,
  archivedVersions: [],
  unchanged: false,
  ...over,
});

describe("formatResult", () => {
  it("lists the version, status and what was created", () => {
    const text = formatResult(result(), { dryRun: false }).join("\n");
    expect(text).toContain("kurikulum-merdeka-fase-d-2025");
    expect(text).toMatch(/draft/i);
    expect(text).toMatch(/8/);
    expect(text).toMatch(/16/);
  });

  it("says nothing changed for an unchanged re-run", () => {
    const text = formatResult(
      result({
        unchanged: true,
        created: { versions: 0, elements: 0, topics: 0, objectives: 0 },
      }),
      { dryRun: false },
    ).join("\n");
    expect(text).toMatch(/tidak ada perubahan/i);
  });

  it("flags a dry run prominently", () => {
    const text = formatResult(result(), { dryRun: true }).join("\n");
    expect(text).toMatch(/uji coba|dry-run/i);
    expect(text).toMatch(/tidak ada yang ditulis|tidak disimpan/i);
  });

  it("names activation and archived versions", () => {
    const text = formatResult(
      result({ versionStatus: "active", activated: true, archivedVersions: ["lama-v1"] }),
      { dryRun: false },
    ).join("\n");
    expect(text).toMatch(/aktif/i);
    expect(text).toContain("lama-v1");
  });
});
