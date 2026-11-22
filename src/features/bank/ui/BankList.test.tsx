// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/features/trash/actions/trash", () => ({ trashQuestionAction: vi.fn() }));
import type { BankListItem } from "@/features/bank/service/bank";
import { BankList } from "./BankList";

afterEach(cleanup);

const item = (over: Partial<BankListItem> = {}): BankListItem => ({
  questionId: "11111111-1111-4111-8111-111111111111",
  topicTitle: "Bilangan Bulat",
  objectiveCode: "7.1",
  difficulty: "sedang",
  type: "multiple_choice",
  status: "terverifikasi",
  stemExcerptMd: "Hitung $2+2$.",
  versionNo: 1,
  bankedAt: "2026-11-08T20:30:00.000Z",
  ...over,
});

describe("BankList", () => {
  it("makes the whole card one link with no nested interactive element and keeps the global focus outline", () => {
    renderWithIntl(<BankList items={[item()]} bankTotal={1} />);
    const link = screen.getByRole("link");
    expect(link.querySelector("a, button, input")).toBeNull();
    expect(link.className).not.toContain("outline-none");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("shows total and verified counts from real data", () => {
    renderWithIntl(
      <BankList
        items={[
          item(),
          item({
            questionId: "22222222-2222-4222-8222-222222222222",
            status: "ketidaksesuaian",
          }),
          item({ questionId: "33333333-3333-4333-8333-333333333333" }),
        ]}
        bankTotal={3}
      />,
    );
    const tiles = screen.getByRole("group", { name: "Ringkasan Bank Soal" });
    expect(tiles.textContent).toContain("Total soal");
    expect(tiles.textContent).toContain("3");
    expect(tiles.textContent).toContain("Terverifikasi");
    expect(tiles.textContent).toContain("2");
  });

  it("hides the verified tile when the list is shorter than the total", () => {
    renderWithIntl(<BankList items={[item()]} bankTotal={150} />);
    const tiles = screen.getByRole("group", { name: "Ringkasan Bank Soal" });
    expect(tiles.textContent).toContain("150");
    expect(tiles.textContent).not.toContain("Terverifikasi");
  });

  it("renders a linked row with topic, TP, difficulty, type, status text, date and excerpt", () => {
    renderWithIntl(<BankList items={[item()]} bankTotal={1} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "/question-bank/11111111-1111-4111-8111-111111111111",
    );
    expect(link.className).toContain("min-h-11");
    const text = link.textContent;
    expect(text).toContain("Bilangan Bulat");
    expect(text).toContain("TP-7.1");
    expect(text).toContain("Sedang");
    expect(text).toContain("Pilihan ganda");
    expect(text).toContain("Terverifikasi otomatis");
    expect(text).toContain("Disimpan 9 November 2026");
    expect(link.querySelector(".katex")).not.toBeNull();
  });

  it("shows the TP code once when the code already starts with TP-", () => {
    renderWithIntl(
      <BankList items={[item({ objectiveCode: "TP-08-GEO-01" })]} bankTotal={1} />,
    );
    const text = screen.getByRole("link").textContent;
    expect(text).toContain("TP-08-GEO-01");
    expect(text).not.toContain("TP TP-");
    expect(text.match(/TP-08-GEO-01/g)).toHaveLength(1);
  });

  it("omits the TP when there is none", () => {
    renderWithIntl(<BankList items={[item({ objectiveCode: null })]} bankTotal={1} />);
    expect(screen.getByRole("link").textContent).not.toContain("TP-");
  });

  it("renders one link per item", () => {
    renderWithIntl(
      <BankList
        items={[
          item(),
          item({
            questionId: "22222222-2222-4222-8222-222222222222",
            status: "ketidaksesuaian",
          }),
        ]}
        bankTotal={2}
      />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.getByText("Ditemukan ketidaksesuaian")).toBeTruthy();
  });

  it("shows the empty state with its hint", () => {
    renderWithIntl(<BankList items={[]} bankTotal={0} />);
    expect(screen.getByText("Belum ada soal di Bank Soal")).toBeTruthy();
    expect(
      screen.getByText("Setujui soal di halaman tinjau lalu pilih Simpan ke Bank Soal."),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Ringkasan Bank Soal" })).toBeNull();
    const create = screen.getByRole("link", { name: "Buat soal" });
    expect(create.getAttribute("href")).toBe("/generate");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it('no-match state shows "no questions match" with reset', () => {
    renderWithIntl(<BankList items={[]} bankTotal={12} resetHref="/question-bank" />);
    expect(screen.getByText("Tidak ada soal yang cocok")).toBeTruthy();
    expect(screen.queryByText("Belum ada soal di Bank Soal")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Atur ulang filter" }).getAttribute("href"),
    ).toBe("/question-bank");
    const tiles = screen.getByRole("group", { name: "Ringkasan Bank Soal" });
    expect(tiles.textContent).toContain("12");
    expect(tiles.textContent).not.toContain("Terverifikasi");
  });

  it("keeps the real bank size in the tile when a filter narrows the list", () => {
    renderWithIntl(<BankList items={[item()]} bankTotal={40} />);
    const tiles = screen.getByRole("group", { name: "Ringkasan Bank Soal" });
    expect(tiles.textContent).toContain("40");
    expect(tiles.textContent).not.toContain("Terverifikasi");
  });

  it("shows the date in the viewer's timezone and language", () => {
    renderWithIntl(<BankList items={[item()]} bankTotal={1} />, {
      locale: "en",
      timeZone: "UTC",
    });
    expect(screen.getByRole("link").textContent).toContain("November 8, 2026");
  });

  it("gives each card a menu button, outside the link, that moves the question to the trash", () => {
    renderWithIntl(
      <BankList
        items={[item(), item({ questionId: "q2", topicTitle: "Pecahan" })]}
        bankTotal={2}
      />,
    );
    const menu = screen.getByRole("button", { name: "Pindahkan ke Sampah: Pecahan" });
    expect(menu.closest("a")).toBeNull();
    expect(menu.className).toContain("size-11");
    expect(
      screen.getByRole("button", { name: "Pindahkan ke Sampah: Bilangan Bulat" }),
    ).toBeTruthy();
  });
});
