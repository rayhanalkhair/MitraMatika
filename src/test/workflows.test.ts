import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  code,
  environmentOf,
  hasShellTracing,
  hasVerboseCurl,
  hasWritePermission,
  jobsOf,
  runsOnPullRequests,
  triggersOf,
  usesPullRequestTarget,
} from "./workflow-checks";

const dir = join(process.cwd(), ".github", "workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));

// One path for every check: comment-stripped text (see `code`), so a comment can neither satisfy
// nor trip an assertion.
function read(file: string): string {
  return code(readFileSync(join(dir, file), "utf8"));
}

describe("workflow files", () => {
  it("finds the expected workflows", () => {
    expect(files.sort()).toEqual([
      "backup.yml",
      "ci.yml",
      "staging-smoke.yml",
      "uptime.yml",
    ]);
  });

  it("jobs-tick.yml does not exist (the daily Vercel Cron replaced it, ADR-0020)", () => {
    expect(existsSync(join(dir, "jobs-tick.yml"))).toBe(false);
  });

  it("no workflow references JOBS_RUNNER_SECRET or JOBS_TICK_URL", () => {
    for (const file of files) {
      const raw = readFileSync(join(dir, file), "utf8");
      expect(raw, file).not.toMatch(/JOBS_RUNNER_SECRET|JOBS_TICK_URL/);
    }
  });

  it("parses at least one job in every workflow, so the loops below are not vacuous", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(jobsOf(read(file)).length, file).toBeGreaterThan(0);
    }
  });

  it("finds pinned actions in the workflows, so the pin loop is not vacuous", () => {
    const total = files.flatMap((f) =>
      read(f)
        .split("\n")
        .filter((l) => /^\s*-?\s*uses:/.test(l)),
    );
    expect(total.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const body = read(file);

    describe(file, () => {
      it("declares top-level least-privilege permissions", () => {
        expect(body).toMatch(/^permissions:\n {2}contents: read$/m);
      });

      it("pins every action to a 40-hex SHA with a tag comment", () => {
        const uses = body.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
        for (const line of uses) {
          expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d[\w.-]*\s*$/);
        }
      });

      it("never uses pull_request_target", () => {
        expect(usesPullRequestTarget(body)).toBe(false);
        expect(body).not.toContain("pull_request_target");
      });

      it("never echoes a secret env var", () => {
        const secretVars = [
          ...body.matchAll(/^\s+(\w+): \$\{\{ secrets\.\w+ \}\}/gm),
        ].map((m) => m[1]);
        for (const name of secretVars) {
          expect(body).not.toMatch(new RegExp(String.raw`echo[^\n]*\$\{?${name}\b`));
        }
      });

      it("uses strict bash in multi-line scripts that call curl", () => {
        for (const m of body.matchAll(/run: \|\n((?: {10,}.*\n?)+)/g)) {
          const script = m[1];
          if (/\bcurl\b/.test(script)) expect(script).toContain("set -euo pipefail");
        }
      });

      if (runsOnPullRequests(body)) {
        it("exposes no secret to jobs that run on pull requests", () => {
          const jobs = jobsOf(body);
          expect(jobs.length).toBeGreaterThan(0);
          for (const job of jobs) {
            if (job.guardedToPush) continue;
            const refs = [...job.text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
            expect(
              refs.filter((r) => r !== "GITHUB_TOKEN"),
              `job ${job.name}`,
            ).toEqual([]);
          }
        });
      }
    });
  }

  it("every setup-node step uses node-version-file .nvmrc and never check-latest", () => {
    let steps = 0;
    for (const file of files) {
      for (const m of read(file).matchAll(
        /^(\s*)- uses: actions\/setup-node@.*\n((?:\1 {2}.*\n?)*)/gm,
      )) {
        steps += 1;
        expect(m[2], file).toMatch(/^\s+node-version-file: \.nvmrc$/m);
        // The version is pinned in .nvmrc; check-latest would let upstream pick it at job time.
        expect(m[2], file).not.toMatch(/check-latest/);
      }
    }
    expect(steps).toBeGreaterThan(0);
  });

  it("prints the Node version in its own step of the verify job", () => {
    const verify = jobsOf(read("ci.yml")).find((j) => j.name === "verify")?.text ?? "";
    expect(verify).toMatch(/- name: Node version\n {8}run: node --version\n/);
  });

  it("runs e2e on pull requests only and migrations on main pushes only", () => {
    const jobs = jobsOf(read("ci.yml"));
    const e2e = jobs.find((j) => j.name === "e2e")?.text ?? "";
    const migrate = jobs.find((j) => j.name === "migrate")?.text ?? "";
    expect(e2e).toContain("if: github.event_name == 'pull_request'");
    expect(migrate).toContain(
      "github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(migrate).toContain("vars.RUN_MIGRATIONS == 'true'");
    expect(migrate).toContain("environment: production");
    expect(migrate).toContain("needs: [verify]");
    expect(migrate).toContain("group: migrate-production");
    expect(migrate).toMatch(/permissions:\n {6}contents: read/);
    expect(migrate).toContain("DATABASE_URL: ${{ secrets.DATABASE_URL }}");
  });

  it("skips env validation at job level in every ci job that typechecks, lints, tests or builds", () => {
    // next.config.ts validates the typed env on any phase it loads in a build; CI has no .env.local,
    // so a step-level flag on one step left `pnpm typecheck` (which loads the config) failing.
    const jobs = jobsOf(read("ci.yml")).filter((j) =>
      /\bpnpm (?:typecheck|lint|test|build)(?![\w:-])/.test(j.text),
    );
    expect(jobs.map((j) => j.name)).toContain("verify");
    for (const job of jobs) {
      expect(job.text, `job ${job.name}`).toMatch(
        /^ {4}env:\n(?: {6}\w+: .*\n)*? {6}SKIP_ENV_VALIDATION: "1"$/m,
      );
    }
  });

  it("keeps the staging and backup workflows manual or scheduled only", () => {
    const manual = ["staging-smoke.yml", "backup.yml", "uptime.yml"];
    for (const file of manual) {
      const triggers = triggersOf(read(file));
      expect(triggers.size, file).toBeGreaterThan(0);
      expect(triggers, file).not.toContain("push");
      expect(runsOnPullRequests(read(file)), file).toBe(false);
    }
    expect(read("staging-smoke.yml")).toContain(
      "pnpm test:generation:staging --confirm-staging",
    );
    expect(read("backup.yml")).toContain("vars.BACKUP_ENABLED");
    const dump = /pg_dump .*/.exec(read("backup.yml"))?.[0] ?? "";
    expect(dump).toContain("--exclude-table-data=public.session");
    expect(dump).toContain("--exclude-table-data=public.verification");
    expect(dump).not.toContain("public.account");
  });

  describe("secret-bearing jobs", () => {
    const all = files.flatMap((file) =>
      jobsOf(read(file)).map((job) => ({
        file,
        job,
        prWorkflow: runsOnPullRequests(read(file)),
        ifLine: /^ {4}if:.*$/m.exec(job.text)?.[0] ?? "",
        environment: environmentOf(job.text),
      })),
    );

    it("detects quoted and mapping environment forms", () => {
      expect(environmentOf('    environment: "production"\n')).toBe("production");
      expect(environmentOf("    environment: production\n")).toBe("production");
      expect(environmentOf("    environment:\n      name: staging\n")).toBe("staging");
      expect(environmentOf("    runs-on: x\n")).toBeUndefined();
    });

    it("finds jobs and pull request workflows, so the loops are not vacuous", () => {
      expect(all.length).toBeGreaterThan(0);
      expect(all.some((j) => j.prWorkflow)).toBe(true);
      expect(all.some((j) => j.environment)).toBe(true);
    });

    it("restricts every environment job except staging to the main branch", () => {
      const guarded = all.filter((j) => j.environment && j.environment !== "staging");
      // ci.yml's migrate job and backup.yml (both `production`).
      expect(guarded.length).toBeGreaterThanOrEqual(2);
      for (const { file, job, ifLine } of guarded) {
        expect(ifLine, `${file}:${job.name}`).toContain(
          "github.ref == 'refs/heads/main'",
        );
      }
    });

    it("never gives an environment to a job that a pull request can reach", () => {
      const reachable = all.filter((j) => j.prWorkflow && j.environment);
      expect(reachable.length).toBeGreaterThan(0);
      for (const { file, job, ifLine } of reachable) {
        expect(job.guardedToPush, `${file}:${job.name} must be push-only`).toBe(true);
        expect(ifLine, `${file}:${job.name}`).toContain(
          "github.ref == 'refs/heads/main'",
        );
      }
    });

    it("keeps secrets off branches: main-only, or the staging environment", () => {
      let withSecrets = 0;
      for (const { file, job, ifLine, environment } of all) {
        const secrets = [...job.text.matchAll(/secrets(?:\.|\[['"])(\w+)/g)]
          .map((m) => m[1])
          .filter((name) => name !== "GITHUB_TOKEN");
        if (secrets.length === 0) continue;
        withSecrets += 1;
        if (environment === "staging") continue;
        expect(ifLine, `${file}:${job.name}`).toContain(
          "github.ref == 'refs/heads/main'",
        );
      }
      expect(withSecrets).toBeGreaterThan(0);
    });

    it("never inherits secrets", () => {
      for (const file of files) expect(read(file)).not.toMatch(/secrets:\s*inherit/);
    });
  });

  describe("permissions", () => {
    it("grants no write scope in a workflow that runs on pull requests", () => {
      const prFiles = files.filter((file) => runsOnPullRequests(read(file)));
      expect(prFiles.length).toBeGreaterThan(0);
      for (const file of prFiles) {
        expect(hasWritePermission(read(file)), file).toBe(false);
      }
    });

    it("lets GITHUB_TOKEN into read-only jobs only", () => {
      let withToken = 0;
      for (const file of files) {
        const body = read(file);
        for (const job of jobsOf(body)) {
          if (!job.text.includes("secrets.GITHUB_TOKEN")) continue;
          withToken += 1;
          expect(hasWritePermission(job.text), `${file}:${job.name}`).toBe(false);
          expect(hasWritePermission(body.split(/^jobs:/m)[0] ?? ""), file).toBe(false);
        }
      }
      expect(withToken).toBeGreaterThan(0);
    });
  });

  it("pins every container image by digest", () => {
    let images = 0;
    for (const file of files) {
      const lines = read(file)
        .split("\n")
        .filter((l) => /^\s+image: /.test(l) || /\bdocker run\b/.test(l));
      images += lines.length;
      for (const line of lines) {
        expect(line, file).toMatch(/@sha256:[0-9a-f]{64}/);
      }
    }
    expect(images).toBeGreaterThan(0);
    expect(read("ci.yml")).toMatch(
      /image: postgres:16@sha256:[0-9a-f]{64} # postgres:16/,
    );
    expect(read("backup.yml")).toMatch(/postgres:\d+@sha256:[0-9a-f]{64}/);
  });

  it("never enables shell tracing or verbose curl", () => {
    let curls = 0;
    for (const file of files) {
      const body = read(file);
      if (/\bcurl\b/.test(body)) curls += 1;
      expect(hasShellTracing(body), `${file}: shell tracing`).toBe(false);
      expect(hasVerboseCurl(body), `${file}: verbose curl`).toBe(false);
    }
    expect(curls).toBeGreaterThan(0);
  });

  it("restricts the secret-bearing scheduled jobs to main", () => {
    expect(read("backup.yml")).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    expect(read("staging-smoke.yml")).not.toContain("refs/heads/main");
  });

  it("disables gitleaks PR comments instead of granting a write scope", () => {
    const secretsJob =
      jobsOf(read("ci.yml")).find((j) => j.name === "secrets")?.text ?? "";
    expect(secretsJob).toContain('GITLEAKS_ENABLE_COMMENTS: "false"');
    expect(secretsJob).toContain("timeout-minutes: 10");
    expect(secretsJob).toMatch(
      /permissions:\n {6}contents: read\n {6}pull-requests: read\n/,
    );
  });
});
