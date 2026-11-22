// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import type { PendingItem } from "@/features/beranda/service/dashboard";
import { PendingList } from "./PendingList";

afterEach(cleanup);

const item = (over: Partial<PendingItem> = {}): PendingItem => ({
  requestId: "22222222-2222-4222-8222-222222222222",
  topicTitle: "Pecahan",
  quantity: 5,
  createdAt: "2026-11-08T05:00:00.000Z",
  undecided: 2,
  readyToSave: 3,
  ...over,
});

describe("PendingList", () => {
  it("shows the calm line when empty", () => {
    renderWithIntl(<PendingList items={[]} />);
    expect(screen.getByText("Tidak ada draf yang menunggu.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a linked row with both counts", () => {
    renderWithIntl(<PendingList items={[item()]} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "/generate/22222222-2222-4222-8222-222222222222",
    );
    expect(link.className).toContain("min-h-11");
    const text = link.textContent;
    expect(text).toContain("Pecahan");
    expect(text).toContain("2 belum diputuskan");
    expect(text).toContain("3 siap disimpan");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("marks the row edge by status: warning while undecided, success when all are ready", () => {
    renderWithIntl(<PendingList items={[item()]} />);
    expect(screen.getByRole("link").className).toContain("border-l-warning");
    cleanup();
    renderWithIntl(<PendingList items={[item({ undecided: 0 })]} />);
    expect(screen.getByRole("link").className).toContain("border-l-success");
  });

  it("omits a zero count line, falls back on the topic and wraps long titles", () => {
    renderWithIntl(<PendingList items={[item({ topicTitle: null, undecided: 0 })]} />);
    const text = screen.getByRole("link").textContent;
    expect(text).not.toContain("belum diputuskan");
    expect(text).toContain("3 siap disimpan");
    expect(screen.getByText("Topik tidak diketahui").className).toContain("break-words");
  });
});
