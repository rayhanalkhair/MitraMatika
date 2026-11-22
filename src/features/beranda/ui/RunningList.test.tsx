// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import type { RunningItem } from "@/features/beranda/service/dashboard";
import { RunningList } from "./RunningList";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T06:00:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const item = (over: Partial<RunningItem> = {}): RunningItem => ({
  requestId: "11111111-1111-4111-8111-111111111111",
  topicTitle: "Bilangan Bulat",
  quantity: 5,
  createdAt: "2026-11-08T05:00:00.000Z",
  jobStatus: "running",
  runAfter: null,
  progress: { done: 1, total: 3 },
  messageKey: null,
  ...over,
});

describe("RunningList", () => {
  it("shows the calm line when empty", () => {
    renderWithIntl(<RunningList items={[]} />);
    expect(screen.getByText("Tidak ada pekerjaan yang berjalan.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a linked row with topic, quantity and status text with an icon", () => {
    renderWithIntl(<RunningList items={[item()]} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "/generate/11111111-1111-4111-8111-111111111111",
    );
    expect(link.className).toContain("min-h-11");
    const text = link.textContent;
    expect(text).toContain("Bilangan Bulat");
    expect(text).toContain("5 soal");
    expect(text).toContain("Soal sedang dibuat");
    expect(text).toContain("Langkah 1 dari 3");
    expect(link.querySelector("svg")).not.toBeNull();
  });

  it("shows the deferred resume time and a fallback topic, and wraps long titles", () => {
    renderWithIntl(
      <RunningList
        items={[
          item({
            topicTitle: null,
            quantity: null,
            jobStatus: "deferred",
            runAfter: "2026-11-08T07:30:00.000Z",
            progress: null,
          }),
        ]}
      />,
    );
    const text = screen.getByRole("link").textContent;
    expect(text).toContain("Topik tidak diketahui");
    expect(text).toContain("14.30");
    expect(text).not.toContain("null");
    expect(screen.getByText("Topik tidak diketahui").className).toContain("break-words");
  });
});
