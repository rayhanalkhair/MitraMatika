import postgres from "postgres";
import {
  cleanupHint,
  describeError,
  isNoAccess,
  isPermissionDenied,
  preflightMessage,
  projectRefFromUrl,
  requireStagingConfirmation,
  runChecks,
  summarize,
  type Check,
} from "../src/lib/db/staging-rls";
import { requireDatabaseUrl } from "../src/lib/env";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Query = (tx: Tx) => PromiseLike<readonly unknown[]>;
interface Result {
  data: readonly unknown[] | null;
  error: unknown;
}

// A teacher's queries run the way the app's user-scoped path does: inside a transaction, as the
// `authenticated` role, with auth.uid() set to the teacher's id (unset for "no session").
interface Teacher {
  userId: string;
  run: (query: Query) => Promise<Result>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// A privilege denial must be exactly SQLSTATE 42501 (no grant, or an RLS WITH CHECK
// violation). Any other error (wrong table, network) is a failure, not a pass.
function assertDenied(error: unknown, what: string): void {
  assert(
    isPermissionDenied(error),
    `${what}: diharapkan 42501, yang diterima: ${describeError(error)}`,
  );
}

// An RLS-filtered read comes back empty without an error. A denied read (no grant) is also
// accepted, but only as 42501; any other error is a failure.
function assertHidden(result: Result, what: string): void {
  if (result.error) {
    assertDenied(result.error, what);
  } else {
    assert(isNoAccess(result), what);
  }
}

function runAs(sql: Sql, userId: string | null): Teacher["run"] {
  return async (query) => {
    try {
      const data = await sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        if (userId) await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
        return query(tx);
      });
      return { data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
}

// A throwaway confirmed user: a plain "user" row, the shape Better Auth writes. The id is
// reported through onCreated the moment the row exists, so the caller can delete it even if a
// later step here fails.
async function createTeacher(
  sql: Sql,
  email: string,
  onCreated: (userId: string) => void,
): Promise<Teacher> {
  const rows = await sql<{ id: string }[]>`
    insert into "user" (name, email, email_verified)
    values ('Pengguna uji sementara', ${email}, true)
    returning id`;
  const row = rows.at(0);
  if (!row) throw new Error(`Gagal membuat pengguna ${email}`);
  onCreated(row.id);
  return { userId: row.id, run: runAs(sql, row.id) };
}

function buildChecks(admin: Sql, anon: Teacher["run"], a: Teacher, b: Teacher): Check[] {
  // Set only once the seed rows are confirmed to exist, so a denial check can never print ok
  // for something it never actually tested.
  let seeded = false;
  const requireSeeded = (): void => {
    assert(seeded, "data awal tidak terkonfirmasi; cek ini tidak dapat dipercaya");
  };

  return [
    {
      name: "each teacher can create their own profile and generation request",
      run: async () => {
        for (const [teacher, label] of [
          [a, "Throwaway A"],
          [b, "Throwaway B"],
        ] as const) {
          const profile = await teacher.run(
            (tx) =>
              tx`insert into profiles (id, display_name) values (${teacher.userId}, ${label})`,
          );
          assert(
            !profile.error,
            `profile insert failed: ${describeError(profile.error)}`,
          );
          const request = await teacher.run(
            (tx) =>
              tx`insert into generation_requests (owner_id) values (${teacher.userId})`,
          );
          assert(
            !request.error,
            `request insert failed: ${describeError(request.error)}`,
          );
        }
      },
    },
    {
      name: "seed rows exist (both profiles and requests, one job for A)",
      run: async () => {
        try {
          await admin`insert into jobs (owner_id, type) values (${a.userId}, 'rls_check')`;
        } catch (error) {
          throw new Error(`service insert of a job failed: ${describeError(error)}`);
        }

        const profiles = await admin`
          select id from profiles where id in (${a.userId}, ${b.userId})`;
        assert(profiles.length === 2, "seed: kedua profil belum ada");
        for (const [teacher, label] of [
          [a, "A"],
          [b, "B"],
        ] as const) {
          const requests = await admin`
            select id from generation_requests where owner_id = ${teacher.userId}`;
          assert(requests.length === 1, `seed: permintaan ${label} belum ada`);
        }
        const jobs = await admin`select id from jobs where owner_id = ${a.userId}`;
        assert(jobs.length === 1, "seed: job A belum ada");
        seeded = true;
      },
    },
    {
      name: "B cannot read A's profile or generation requests",
      run: async () => {
        requireSeeded();
        const profile = await b.run(
          (tx) => tx`select * from profiles where id = ${a.userId}`,
        );
        assertHidden(profile, "B could read A's profile");
        const requests = await b.run(
          (tx) => tx`select * from generation_requests where owner_id = ${a.userId}`,
        );
        assertHidden(requests, "B could read A's generation requests");
      },
    },
    {
      name: "B cannot update A's profile",
      run: async () => {
        requireSeeded();
        await b.run(
          (tx) => tx`update profiles set display_name = 'hacked' where id = ${a.userId}`,
        );
        const check = await admin<{ display_name: string | null }[]>`
          select display_name from profiles where id = ${a.userId}`;
        assert(
          check.at(0)?.display_name === "Throwaway A",
          "A's profile was changed by B",
        );
      },
    },
    {
      name: "B cannot delete A's profile",
      run: async () => {
        requireSeeded();
        const result = await b.run(
          (tx) => tx`delete from profiles where id = ${a.userId}`,
        );
        assertDenied(result.error, "B deleting A's profile");
        const check = await admin`select id from profiles where id = ${a.userId}`;
        assert(check.length === 1, "A's profile was deleted by B");
      },
    },
    {
      name: "a teacher cannot delete their own profile",
      run: async () => {
        requireSeeded();
        const result = await a.run(
          (tx) => tx`delete from profiles where id = ${a.userId}`,
        );
        assertDenied(result.error, "A deleting their own profile");
        const check = await admin`select id from profiles where id = ${a.userId}`;
        assert(check.length === 1, "A's profile was deleted by A");
      },
    },
    {
      name: "B cannot insert a generation request owned by A",
      run: async () => {
        requireSeeded();
        const result = await b.run(
          (tx) => tx`insert into generation_requests (owner_id) values (${a.userId})`,
        );
        assertDenied(result.error, "B inserting a request owned by A");
      },
    },
    {
      name: "B cannot update or delete A's generation request",
      run: async () => {
        requireSeeded();
        const before = await admin<{ id: string; status: string }[]>`
          select id, status from generation_requests where owner_id = ${a.userId}`;
        assert(before.length === 1, "A's request is missing before the attempt");
        const original = before.at(0);

        const update = await b.run(
          (tx) =>
            tx`update generation_requests set status = 'succeeded' where owner_id = ${a.userId}`,
        );
        assertDenied(update.error, "B updating A's request");
        const remove = await b.run(
          (tx) => tx`delete from generation_requests where owner_id = ${a.userId}`,
        );
        assertDenied(remove.error, "B deleting A's request");

        const after = await admin<{ id: string; status: string }[]>`
          select id, status from generation_requests where owner_id = ${a.userId}`;
        assert(after.length === 1, "A's request was deleted by B");
        assert(
          after.at(0)?.id === original?.id && after.at(0)?.status === original?.status,
          "A's request was changed by B",
        );
      },
    },
    {
      name: "a teacher reads their own job but never another's, and cannot insert jobs",
      run: async () => {
        requireSeeded();
        const own = await a.run(
          (tx) => tx`select id from jobs where owner_id = ${a.userId}`,
        );
        assert(!own.error, `A could not read their own job: ${describeError(own.error)}`);
        assert((own.data?.length ?? 0) === 1, "A could not read their own job");
        const other = await b.run(
          (tx) => tx`select id from jobs where owner_id = ${a.userId}`,
        );
        assertHidden(other, "B could read A's job");
        const insert = await a.run(
          (tx) => tx`insert into jobs (owner_id, type) values (${a.userId}, 'x')`,
        );
        assertDenied(insert.error, "a teacher inserting into jobs");
      },
    },
    {
      name: "a teacher can neither read nor write audit_log, usage_events or app_errors",
      run: async () => {
        const inserts: [string, Query][] = [
          [
            "audit_log",
            (tx) =>
              tx`insert into audit_log (owner_id, action) values (${a.userId}, 'rls-check')`,
          ],
          [
            "usage_events",
            (tx) =>
              tx`insert into usage_events (owner_id, event) values (${a.userId}, 'rls-check')`,
          ],
          [
            "app_errors",
            (tx) =>
              tx`insert into app_errors (source, message) values ('rls-check', 'rls-check')`,
          ],
        ];
        for (const [table, insert] of inserts) {
          const read = await a.run((tx) => tx`select * from ${tx(table)}`);
          assertDenied(read.error, `a teacher reading ${table}`);
          const write = await a.run(insert);
          assertDenied(write.error, `a teacher inserting into ${table}`);
        }
      },
    },
    {
      name: "curriculum is readable but not writable by a teacher",
      run: async () => {
        const read = await a.run((tx) => tx`select id from curriculum_versions limit 1`);
        assert(
          read.error === null,
          `curriculum read failed: ${describeError(read.error)}`,
        );
        const write = await a.run(
          (tx) => tx`
            insert into curriculum_versions
              (code, title, source_title, source_url, published_on, retrieved_on)
            values
              ('rls-check', 'x', 'x', 'https://example.test', '2025-01-01', '2025-01-01')`,
        );
        assertDenied(write.error, "a teacher writing to curriculum_versions");
      },
    },
    {
      name: "the authenticated role without a user id sees and writes nothing",
      run: async () => {
        requireSeeded();
        const read = await anon((tx) => tx`select * from profiles`);
        assertHidden(read, "a session-less caller could read profiles");
        const write = await anon(
          (tx) => tx`insert into generation_requests (owner_id) values (${a.userId})`,
        );
        assertDenied(write.error, "a session-less caller inserting a generation request");
      },
    },
  ];
}

async function main(): Promise<void> {
  requireStagingConfirmation(process.argv.slice(2));
  const databaseUrl = requireDatabaseUrl();
  console.log(`Basis data: ${projectRefFromUrl(databaseUrl)}`);

  // The table owner, like the app's service connection: it bypasses RLS.
  const admin = postgres(databaseUrl, { max: 2, prepare: false });
  const stamp = Date.now();
  const createdUserIds: string[] = [];
  const remember = (userId: string): void => void createdUserIds.push(userId);

  try {
    // Without the migrations the script would create users and orphan profile rows, so verify
    // first and stop before any user exists.
    try {
      await admin`select id from question_versions limit 1`;
    } catch (error) {
      console.error(preflightMessage(error));
      process.exitCode = 1;
      return;
    }

    try {
      const a = await createTeacher(
        admin,
        `rls-a-${String(stamp)}@example.test`,
        remember,
      );
      const b = await createTeacher(
        admin,
        `rls-b-${String(stamp)}@example.test`,
        remember,
      );

      const results = await runChecks(buildChecks(admin, runAs(admin, null), a, b));
      for (const result of results) {
        console.log(
          result.ok
            ? `  ok    ${result.name}`
            : `  GAGAL ${result.name}: ${String(result.error)}`,
        );
      }
      const { passed, failed } = summarize(results);
      console.log(`\n${String(passed)} lolos, ${String(failed)} gagal.`);
      if (failed > 0) process.exitCode = 1;
    } catch (error) {
      console.error(
        "Uji RLS staging gagal:",
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    } finally {
      // Deleting the user rows cascades through everything the checks created.
      for (const id of createdUserIds) {
        try {
          await admin`delete from "user" where id = ${id}`;
        } catch (error) {
          console.error(
            `Gagal menghapus pengguna ${id}:`,
            error instanceof Error ? error.message : error,
          );
          process.exitCode = 1;
        }
      }
      if (process.exitCode) console.error(cleanupHint(stamp));
    }
  } finally {
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error("Uji RLS staging gagal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
