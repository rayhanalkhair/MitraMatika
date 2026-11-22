import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface VercelConfig {
  regions?: string[];
  crons?: { path: string; schedule: string }[];
}

const config = JSON.parse(
  readFileSync(join(process.cwd(), "vercel.json"), "utf8"),
) as VercelConfig;

describe("vercel.json", () => {
  it("keeps the functions in Singapore", () => {
    expect(config.regions).toEqual(["sin1"]);
  });

  it('has exactly one cron, path /api/jobs/run, schedule "0 19 * * *"', () => {
    expect(config.crons).toEqual([{ path: "/api/jobs/run", schedule: "0 19 * * *" }]);
  });

  it("fixes the cron's minute and hour and leaves the other three fields *", () => {
    // Hobby allows at most one run a day: a fixed minute and hour, every day.
    expect(config.crons?.length).toBeGreaterThan(0);
    for (const { schedule } of config.crons ?? []) {
      const fields = schedule.split(" ");
      expect(fields).toHaveLength(5);
      expect(fields[0]).toMatch(/^\d{1,2}$/);
      expect(fields[1]).toMatch(/^\d{1,2}$/);
      expect(fields.slice(2)).toEqual(["*", "*", "*"]);
    }
  });

  it("the cron path's route file exports GET", () => {
    expect(config.crons?.length).toBeGreaterThan(0);
    for (const { path } of config.crons ?? []) {
      const file = join(process.cwd(), "src", "app", ...path.split("/").filter(Boolean));
      const route = join(file, "route.ts");
      expect(existsSync(route), route).toBe(true);
      expect(readFileSync(route, "utf8")).toMatch(/^export (?:async )?function GET\(/m);
    }
  });
});
