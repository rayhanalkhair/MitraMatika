# MitraMatika

An AI assistant for one Indonesian mathematics teacher: generate Grade 8 questions from the Kurikulum Merdeka curriculum, verify the math, review and approve each question, and keep an approved question bank. Private MVP, Indonesian UI, Rp0 recurring cost.

## Stack

The app follows the owner's personal default stack:

- **App:** TypeScript (strict), Next.js App Router, React 19, Tailwind CSS 4 with shadcn/ui on Base UI, Zod, TanStack Query (job-status polling), `next-intl` (Indonesian by default, English available).
- **Data:** Postgres on Neon, Drizzle ORM (v1 release candidate, exact pin) with generated SQL migrations in `drizzle/`.
- **Auth and email:** Better Auth (open sign-up with a verified email and a password, or Google; one account per email; tables in the app database; limits stored in the database), Resend for the verification and password-reset emails (a verified Resend domain is required in production).
- **Files and backups:** Cloudflare R2 through the S3 API (backups now, uploads in Phase 5).
- **AI:** Groq (primary) and Gemini (curriculum-only fallback) behind a provider adapter.
- **Hosting and automation:** Vercel Hobby (region `sin1`) with one daily Vercel Cron for the background jobs; GitHub Actions for CI, the uptime ping and the weekly backup.
- **Quality:** Vitest with PGlite, Playwright (CI only), ESLint, Prettier, Husky with lint-staged and commitlint, pino JSON logs.
- **Tooling:** pnpm 12 and Node 26 (see `packageManager` and `engines` in `package.json`).

The Supabase-era version of the app is preserved at the git tag `v0.1.0-supabase-stack`.

## Setup

```bash
npm i -g pnpm@12        # Node 25 and newer ship no Corepack
pnpm install
cp .env.example .env.local   # fill in your own keys; never commit .env.local
pnpm dev                     # http://localhost:3000
```

`.env.local` needs at least `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and, for generation, `GROQ_API_KEY`. Sign-up is open and there is no allowlist; without `RESEND_API_KEY` and `EMAIL_FROM` no verification email is sent, so locally either set up Resend or use Google sign-in (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`). Every variable is described in `.env.example`.

Use a LOCAL or throwaway database for development. `pnpm db:migrate`, `pnpm db:seed:curriculum` and the `*:staging` scripts write to whatever `DATABASE_URL` points at, so never point `.env.local` at production. To get a local Postgres, run any stock Postgres 16 or newer. For example, for local use only: `docker run --name mitramatika-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mitramatika -p 5432:5432 postgres:16`, and set `DATABASE_URL=postgres://postgres:postgres@localhost:5432/mitramatika` (plus a local `BETTER_AUTH_SECRET` of 32 or more characters) in `.env.local`. Then:

```bash
pnpm db:migrate                       # creates everything on a stock Postgres
pnpm db:seed:curriculum --activate    # loads the Grade 8 curriculum
```

Before sending a change, run `pnpm verify` (typecheck, lint, unit tests, build).

## Scripts

| Script                                                              | What it does                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`, `pnpm build`, `pnpm start`                              | Next.js development server, production build, production server                      |
| `pnpm verify`                                                       | typecheck, lint, tests and build, in that order                                      |
| `pnpm typecheck`, `pnpm lint`, `pnpm test`                          | one gate each (`test` is Vitest)                                                     |
| `pnpm format`, `pnpm format:check`                                  | Prettier write and check                                                             |
| `pnpm test:e2e`                                                     | Playwright; meant for CI only (needs a local throwaway database and `E2E_CI=1`)       |
| `pnpm db:generate`                                                  | generate a Drizzle migration from the schema in `src/lib/db/tables`                  |
| `pnpm db:migrate`                                                   | apply pending migrations to `DATABASE_URL`                                           |
| `pnpm db:seed:curriculum [--activate] [--dry-run] [--file <path>]`  | load a curriculum seed (default `data/curriculum/grade-8-v1.json`)                   |
| `pnpm ai:smoke`, `pnpm eval`, `pnpm eval:real`                      | AI smoke test and evaluation harness; the `real` variants spend free-tier quota      |
| `pnpm test:generation:staging`, `test:jobs:staging`, `test:rls:staging` | smoke scripts against a real staging database; need `--confirm-staging`; see the private runbook |

## Project layout

```text
src/app/                     routes (English paths such as /generate), layouts, route handlers
src/features/<name>/         one folder per feature: auth, curriculum, generation, verification,
  service/ schema/             review, bank, beranda, settings, eval. service = server logic,
  actions/ ui/ index.ts        schema = Zod schemas and types, actions = Server Actions, ui = components
src/lib/                     shared infrastructure: ai (provider gateway), db (schema, client, migrate),
                             jobs (queue and runner), email, events, i18n, env, logger, timezone
src/components/              shared UI components (shell, math, ...)
src/proxy.ts                 optimistic session-cookie check (the real check is the guard in features/auth)
messages/{id,en}.json        UI text (next-intl)
drizzle/                     generated and hand-written SQL migrations
data/                        curriculum seed and golden set
scripts/                     seed, staging smoke and CI helper scripts
tests/e2e/                   Playwright specs
.github/workflows/           ci, uptime, backup, staging-smoke
```

## Testing

- **Unit and integration:** Vitest, with PGlite (an in-process Postgres) for database tests, including the RLS isolation suite. `pnpm test` needs no database and no network. Vitest runs in forked processes (`pool: "forks"`) with a bounded worker count and longer timeouts (and `retry: 1` only in CI), because PGlite is WebAssembly and parallel workers failed under load.
- **End to end:** Playwright on Chromium (Pixel and desktop projects), run in CI against a throwaway Postgres 16 service with scripted AI and a fake sign-in. Do not run it locally against a real database; its config refuses a non-local `DATABASE_URL`.
- **Real providers:** `pnpm test:generation:staging` (through the manual `Staging smoke` workflow) and `pnpm eval:real` spend free-tier quota; run them deliberately.

## Contributing

- Branch from `main`; trunk-based. Open a pull request using the template; CI (`verify`, `e2e`, `secrets`) must pass.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:` ...), enforced by commitlint in the `commit-msg` hook. The pre-commit hook runs lint-staged (ESLint and Prettier).
- **Squash merges only**; the squash title is the Conventional Commit. History is linear and head branches are deleted on merge.
- **Commits are GPG-signed**, and the developer is the sole author (no co-author or tool trailers, D-029).
- Never commit secrets. `gitleaks` runs in CI; there is no Dependabot, so dependency and action updates are deliberate.
- Migrations are forward-fix only and must work with both the old and the new code (expand, then contract); see the private runbook.

## Documentation

The product, architecture and operations documents are kept in a private repository. Environment variables are described in `.env.example`.
