import { describe, expect, it } from "vitest";
import { assessmentReturnTo, generateHref, parseSince, safeReturnTo } from "./return-to";

describe("safeReturnTo", () => {
  it("keeps a path inside the app", () => {
    expect(safeReturnTo("/generate/abc", "/x")).toBe("/generate/abc");
    expect(safeReturnTo("/question-bank?page=2&q=a", "/x")).toBe(
      "/question-bank?page=2&q=a",
    );
  });

  it.each([
    undefined,
    "",
    "generate",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "/a\nb",
    ["/a", "/b"],
  ])("falls back for %j", (value) => {
    expect(safeReturnTo(value, "/fallback")).toBe("/fallback");
  });
});

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("assessmentReturnTo", () => {
  it("accepts the editor path, with or without since", () => {
    expect(assessmentReturnTo(`/assessment-builder/${ID}`)).toBe(
      `/assessment-builder/${ID}`,
    );
    const since = `/assessment-builder/${ID}?since=2026-11-19T10%3A00%3A00.000Z`;
    expect(assessmentReturnTo(since)).toBe(since);
  });

  it.each([
    undefined,
    ["/assessment-builder/" + ID],
    "",
    "/question-bank",
    "/assessment-builder",
    "/assessment-builder/not-a-uuid",
    `//evil.test/assessment-builder/${ID}`,
    `https://evil.test/assessment-builder/${ID}`,
    `/assessment-builder/${ID}?next=https://evil.test`,
    `/assessment-builder/${ID}/../../settings`,
    `/assessment-builder/${ID}\evil`,
    `/assessment-builder/${ID}?since=<script>`,
  ])("drops %j", (value) => {
    expect(assessmentReturnTo(value)).toBeNull();
  });
});

describe("generateHref", () => {
  it("builds a link that survives its own check", () => {
    const href = generateHref(ID, "2026-11-19T10:00:00.000Z");
    const back = new URL(href, "http://x").searchParams.get("returnTo");
    expect(assessmentReturnTo(back ?? undefined)).toBe(back);
    expect(
      parseSince(new URL(back ?? "", "http://x").searchParams.get("since") ?? ""),
    ).toEqual(new Date("2026-11-19T10:00:00.000Z"));
  });
});

describe("parseSince", () => {
  it("is null for a missing or invalid time", () => {
    expect(parseSince(undefined)).toBeNull();
    expect(parseSince("tomorrow-ish")).toBeNull();
  });
});
