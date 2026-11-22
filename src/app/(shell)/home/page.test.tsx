// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import type { Dashboard } from "@/features/beranda";

const state = vi.hoisted<{
  displayName: string | null;
  dashboard: unknown;
  recent: unknown[];
}>(() => ({
  displayName: "Siti Rahmawati",
  dashboard: null,
  recent: [],
}));

vi.mock("@/features/auth", () => ({
  requireAllowedUser: () =>
    Promise.resolve({
      userId: "u1",
      email: "siti@example.test",
      displayName: state.displayName,
    }),
}));
vi.mock("@/lib/db/runtime", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/db/client", () => ({
  runAsUser: (_db: unknown, _id: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("@/features/beranda/service/dashboard", () => ({
  getDashboard: () => Promise.resolve(state.dashboard),
}));
vi.mock("@/features/beranda/service/recent-assessments", () => ({
  getRecentAssessments: () => Promise.resolve(state.recent),
}));

import HomePage from "./page";

const REQUEST = "22222222-2222-4222-8222-222222222222";

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    hasActivity: true,
    running: [],
    pending: [],
    bankedCount: 0,
    undecidedTotal: 0,
    ...over,
  };
}

async function renderPage(d: Dashboard) {
  state.dashboard = d;
  return renderWithIntl(await HomePage());
}

beforeEach(() => {
  state.displayName = "Siti Rahmawati";
  state.recent = [];
});
afterEach(cleanup);

describe("Home", () => {
  it("greets with the user's first name", async () => {
    await renderPage(dashboard());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toContain("Siti");
    expect(h1.textContent).not.toContain("Rahmawati");
  });

  it("falls back to a neutral greeting without a name and never shows the email", async () => {
    state.displayName = null;
    const { container } = await renderPage(dashboard());
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Selamat datang");
    expect(container.textContent).not.toContain("siti@example.test");
  });

  it("shows three summary tiles from the dashboard data", async () => {
    await renderPage(
      dashboard({
        bankedCount: 12,
        undecidedTotal: 9,
        running: [
          {
            requestId: "11111111-1111-4111-8111-111111111111",
            topicTitle: "SPLDV",
            quantity: 5,
            createdAt: "2026-11-08T05:00:00.000Z",
            jobStatus: "running",
            runAfter: null,
            progress: null,
            messageKey: null,
          },
        ],
        pending: [
          {
            requestId: REQUEST,
            topicTitle: "Pecahan",
            quantity: 5,
            createdAt: "2026-11-08T05:00:00.000Z",
            undecided: 2,
            readyToSave: 1,
          },
          {
            requestId: "33333333-3333-4333-8333-333333333333",
            topicTitle: "Aljabar",
            quantity: 5,
            createdAt: "2026-11-08T05:00:00.000Z",
            undecided: 3,
            readyToSave: 0,
          },
        ],
      }),
    );
    const tiles = screen.getByRole("list", { name: "Ringkasan" });
    const items = within(tiles).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    const text = (label: string) =>
      items.find((li) => li.textContent.includes(label))?.textContent ?? "";
    expect(text("Draf perlu ditinjau")).toContain("9");
    expect(text("Soal di Bank Soal")).toContain("12");
    expect(text("Pekerjaan berjalan")).toContain("1");
  });

  it("first-run state invites the first generation with one primary button", async () => {
    await renderPage(dashboard({ hasActivity: false }));
    const links = screen.getAllByRole("link", { name: "Buat soal pertama" });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/generate");
    expect(screen.queryByRole("link", { name: "Buat soal" })).toBeNull();
    expect(
      screen.getByText("Pilih topik, lalu AI menyiapkan soal untuk Anda tinjau."),
    ).toBeTruthy();
  });

  it("returning state shows one primary Buat soal button", async () => {
    await renderPage(dashboard());
    expect(screen.getAllByRole("link", { name: "Buat soal" })).toHaveLength(1);
  });

  it("draft list rows link to /generate/[requestId]", async () => {
    await renderPage(
      dashboard({
        pending: [
          {
            requestId: REQUEST,
            topicTitle: "Pecahan",
            quantity: 5,
            createdAt: "2026-11-08T05:00:00.000Z",
            undecided: 2,
            readyToSave: 0,
          },
        ],
      }),
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Draf yang perlu ditinjau" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pecahan/ }).getAttribute("href")).toBe(
      `/generate/${REQUEST}`,
    );
  });

  it("has no packages section", async () => {
    const { container } = await renderPage(dashboard({ bankedCount: 3 }));
    expect(container.textContent).not.toMatch(/paket|package/i);
  });

  it("lists the recent assessments with their status, each linking to its editor", async () => {
    state.recent = [
      {
        id: "44444444-4444-4444-8444-444444444444",
        title: "Ulangan Bab 2",
        status: "approved",
        updatedAt: "2026-11-19T05:00:00.000Z",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        title: "Latihan Pecahan",
        status: "draft",
        updatedAt: "2026-11-18T05:00:00.000Z",
      },
    ];
    await renderPage(dashboard());
    const section = screen
      .getByRole("heading", { level: 2, name: "Asesmen terbaru" })
      .closest("section");
    if (!section) throw new Error("no section");
    const links = within(section).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/assessment-builder/44444444-4444-4444-8444-444444444444",
      "/assessment-builder/55555555-5555-4555-8555-555555555555",
      "/assessment-builder",
    ]);
    expect(links[0].textContent).toContain("Ulangan Bab 2");
    expect(links[0].textContent).toContain("Disetujui");
    expect(links[1].textContent).toContain("Draf");
    expect(links[2].textContent).toBe("Lihat semua asesmen");
  });

  it("says so when there is no assessment yet", async () => {
    await renderPage(dashboard());
    const section = screen
      .getByRole("heading", { level: 2, name: "Asesmen terbaru" })
      .closest("section");
    expect(section?.textContent).toContain("Belum ada asesmen.");
  });
});
