import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { LOCALE_COOKIE, type Locale } from "../../src/lib/i18n/config";
import { E2E_RUNNER_SECRET, signedInState } from "./auth";

const BASE_URL = "http://localhost:3000";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag22aa"];

// The two viewports the redesign is checked at: a phone and the 1280 px content width.
export const PHONE = { width: 390, height: 844 } as const;
export const DESKTOP = { width: 1280, height: 800 } as const;

// Runs `body` on a fresh page of its own context at the given viewport, signed in as the fake user
// (or anonymous), with the UI locale cookie set when `locale` is given. The context is always closed.
export async function withViewport(
  browser: Browser,
  options: {
    viewport: { width: number; height: number };
    locale?: Locale;
    anonymous?: boolean;
  },
  body: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({
    storageState: options.anonymous ? undefined : signedInState(),
    viewport: options.viewport,
    baseURL: BASE_URL,
  });
  try {
    if (options.locale) {
      await context.addCookies([
        { name: LOCALE_COOKIE, value: options.locale, url: BASE_URL },
      ]);
    }
    await body(await context.newPage());
  } finally {
    await context.close();
  }
}

type AxeViolation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

function reportViolations(violations: AxeViolation[], label?: string) {
  if (violations.length === 0) return;
  console.log(
    `axe violations${label ? ` on ${label}` : ""}:`,
    JSON.stringify(
      violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        targets: v.nodes.map((n) => n.target),
      })),
      null,
      2,
    ),
  );
}

// axe cannot look inside an iframe whose sandbox forbids scripts (the document preview): it
// injects its script into every frame and the analysis then never ends. So that frame is left out
// of the page scan and its document, the srcdoc, is scanned on a page of its own instead.
const SANDBOXED_FRAME = "iframe[sandbox]";

export async function expectNoAxeViolations(page: Page, label?: string) {
  const results = await new AxeBuilder({ page })
    .exclude(SANDBOXED_FRAME)
    .withTags(WCAG_TAGS)
    .analyze();
  reportViolations(results.violations, label);
  expect(results.violations, label).toEqual([]);

  const documents = await page
    .locator(SANDBOXED_FRAME)
    .evaluateAll((frames) =>
      frames.map((frame) => frame.getAttribute("srcdoc") ?? "").filter(Boolean),
    );
  for (const html of documents) {
    const standalone = await page.context().newPage();
    try {
      await standalone.setContent(html);
      const inner = await new AxeBuilder({ page: standalone })
        .withTags(WCAG_TAGS)
        .analyze();
      const innerLabel = `${label ?? "page"} (sandboxed document)`;
      reportViolations(inner.violations, innerLabel);
      expect(inner.violations, innerLabel).toEqual([]);
    } finally {
      await standalone.close();
    }
  }
}

export async function expectNoHorizontalScroll(page: Page, label?: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, label).toBeLessThanOrEqual(innerWidth);
}

export type Scenario =
  | "valid"
  | "malformed_repairable"
  | "malformed_twice"
  | "wrong_key_persistent"
  | "rate_limited"
  | "invented_citation";

// CI runs the Next dev server, which compiles a route on its first request. A navigation to a page
// the run has not visited yet (the other project may be first) can take longer than the default 5 s
// assertion timeout, so assertions right after such a navigation use this. The global test timeout
// is unchanged.
export const NAVIGATION_TIMEOUT = 30_000;

// Real UI strings (the Indonesian catalog, messages/id.json). Kept here so every spec reads the same text.
export const T = {
  topicSearch: "Cari topik",
  // "Sistem Persamaan Linear Dua Variabel (SPLDV)" in data/curriculum/grade-8-v1.json.
  topicQuery: "SPLDV",
  topicTitle: /Sistem Persamaan Linear Dua Variabel/,
  submit: "Buat soal",
  finished: "Selesai",
  checking: "Sedang diperiksa",
  verified: "Terverifikasi otomatis",
  mismatch: "Ditemukan ketidaksesuaian",
} as const;

export const GENERATION_WAIT = 120_000;

const REQUEST_URL =
  /\/generate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function control(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/api/e2e/control", { data: body });
  expect(response.status(), "POST /api/e2e/control").toBe(200);
}

// Selecting a scenario also resets the scripted AI's call counters.
export async function setScenario(request: APIRequestContext, scenario: Scenario) {
  await control(request, { scenario });
}

// Also moves the fake user's requests of the last day back one day, so every generation spec
// starts with a clean daily budget (all specs share the one fake user; see the 30-per-day limit),
// and deletes the fake user's assessments, templates and exports (with their export jobs, so the
// hourly export cap starts again), materials, folders, uploads and solver sessions (with their
// stored files, and giving back the day's OCR pages and solves). A serial spec that keeps an
// assessment or a material across its tests calls this before and after the file, and
// resetAiAndDailyUsage after each test.
export async function resetScenario(request: APIRequestContext) {
  await resetAiAndDailyUsage(request);
  await control(request, { resetAssessments: true });
  await control(request, { resetMaterials: true });
  await control(request, { resetSolver: true });
}

// The scripted AI back to "valid" with fresh counters, and today's question budget back to full;
// the fake user's assessments, materials and solver sessions stay.
export async function resetAiAndDailyUsage(request: APIRequestContext) {
  await control(request, { reset: true });
  await control(request, { resetDailyUsage: true });
}

// Uses up the fake user's whole daily question budget (the daily-limit spec).
export async function fillDailyUsage(request: APIRequestContext) {
  await control(request, { fillDailyUsage: true });
}

// Makes the fake user's deferred jobs due and runs them once.
export async function expedite(request: APIRequestContext) {
  await control(request, { expedite: true });
}

// Asks the job runner to run what is due (the retry backoff of a failed attempt is 30 s, then
// 60 s; nothing ticks the queue in CI). Accepted with 202 and run after the response.
export async function runDueJobs(request: APIRequestContext) {
  const response = await request.post("/api/jobs/run", {
    headers: { Authorization: `Bearer ${E2E_RUNNER_SECRET}` },
  });
  expect(response.status(), "POST /api/jobs/run").toBe(202);
}

// Picks the topic by searching, submits with the default quantity (5) and difficulty (Sedang),
// and waits for the request page.
export async function createRequest(
  page: Page,
  { topicQuery = T.topicQuery }: { topicQuery?: string } = {},
) {
  await submitRequest(page, { topicQuery });
  await page.waitForURL(REQUEST_URL, { timeout: GENERATION_WAIT });
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

// Fills and submits the generation form without waiting for the outcome.
export async function submitRequest(
  page: Page,
  { topicQuery = T.topicQuery }: { topicQuery?: string } = {},
) {
  await page.goto("/generate");
  await pickTopic(page, topicQuery);
  await page.getByRole("button", { name: T.submit, exact: true }).click();
}

// On /generate: picks the topic by searching (the form is not submitted).
export async function pickTopic(page: Page, topicQuery: string = T.topicQuery) {
  const search = page.getByRole("searchbox", { name: T.topicSearch });
  await search.fill(topicQuery);
  // The count only changes from "8 topik ditemukan" once the page is hydrated and filtered.
  await expect(page.getByText("1 topik ditemukan", { exact: true })).toBeVisible();
  const topic = page.getByRole("radio", { name: T.topicTitle });
  await topic.check();
  await expect(topic).toBeChecked();
  // The selected-topic summary: the title is an h4 under the "Topik dipilih" h3.
  await expect(page.getByRole("heading", { name: T.topicTitle, level: 4 })).toBeVisible();
}

export function questionCards(page: Page): Locator {
  return page.getByRole("article");
}

// n question cards (drafts are listed as soon as they are saved, before checking ends).
export async function waitForQuestions(page: Page, n: number) {
  await expect(questionCards(page)).toHaveCount(n, { timeout: GENERATION_WAIT });
}

// The request status says "Selesai": the job is done and the cards show their final statuses.
export async function waitForFinished(page: Page) {
  await expect(page.getByText(T.finished, { exact: true })).toBeVisible({
    timeout: GENERATION_WAIT,
  });
}

// Reloads `page` until `ready` passes: for pages that do not poll (a material being read, a page
// being OCR'd), where the background job finishes after the response.
export async function reloadUntil(
  page: Page,
  ready: () => Promise<void>,
  timeout: number = GENERATION_WAIT,
) {
  await expect(async () => {
    await page.reload();
    await ready();
  }).toPass({ timeout, intervals: [1_000, 2_000, 3_000] });
}

// Waits for n cards and the finished job: what a populated request page looks like.
export async function waitForReviewReady(page: Page, n = 5) {
  await waitForQuestions(page, n);
  await waitForFinished(page);
  await expect(page.getByText(T.checking, { exact: true })).toHaveCount(0);
}
