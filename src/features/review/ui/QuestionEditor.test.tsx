// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { IntlWrapper, renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  editQuestionAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("../actions/edit-question", () => ({
  editQuestionAction: mocks.editQuestionAction,
}));

import type { EditInput } from "../schema/edit-input";
import { QuestionEditor } from "./QuestionEditor";

const initial: EditInput = {
  stemMd: "Hitung $1 + 1$.",
  options: [
    { label: "A", textMd: "1" },
    { label: "B", textMd: "2" },
    { label: "C", textMd: "3" },
    { label: "D", textMd: "4" },
  ],
  correctLabel: "B",
  answerDisplayMd: "2",
  explanationMd: "Jumlahkan.",
  steps: ["Tulis soalnya.", "Jumlahkan."],
};
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_KEY = `question-edit-draft:${QUESTION_ID}`;

function renderEditor(over: Partial<Parameters<typeof QuestionEditor>[0]> = {}) {
  return renderWithIntl(
    <QuestionEditor
      questionId={QUESTION_ID}
      rowVersion={3}
      initial={initial}
      approved={false}
      banked={false}
      returnTo="/generate/abc"
      {...over}
    />,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
  mocks.editQuestionAction.mockResolvedValue({
    ok: true,
    versionId: "v2",
    status: "terverifikasi",
  });
});
afterEach(cleanup);

describe("QuestionEditor, server render", () => {
  // React Hook Form gives every step a random key; an id built from it differs between the
  // server's HTML and the browser's first render, a hydration mismatch React does not repair.
  it("renders the same ids every time (no random part in a step's id)", () => {
    const html = () =>
      renderToString(
        <IntlWrapper>
          <QuestionEditor
            questionId={QUESTION_ID}
            rowVersion={3}
            initial={initial}
            approved={false}
            banked={false}
            returnTo="/generate/abc"
          />
        </IntlWrapper>,
      );
    const first = html();
    expect(html()).toBe(first);
    expect(first).toContain("-steps-0");
    expect(first).toContain("-steps-1");
  });
});

describe("QuestionEditor", () => {
  it("shows every field with its current text and a math preview", () => {
    const { container } = renderEditor();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Teks soal").value).toBe(
      initial.stemMd,
    );
    expect(screen.getByLabelText<HTMLInputElement>("Teks pilihan C").value).toBe("3");
    expect(
      screen.getByLabelText<HTMLInputElement>("Jadikan pilihan B kunci jawaban").checked,
    ).toBe(true);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Langkah 1").value).toBe(
      "Tulis soalnya.",
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>("Langkah 2").value).toBe(
      "Jumlahkan.",
    );
    // The stem preview renders the $...$ span with KaTeX.
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(0);
  });

  it("updates the preview while typing", async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    const stem = screen.getByLabelText("Teks soal");
    await user.clear(stem);
    await user.type(stem, "Hasil $x^2$?");
    expect(container.textContent).toContain("Hasil");
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("saves the edited content with the row version it was opened at, then goes to returnTo", async () => {
    const user = userEvent.setup();
    renderEditor();
    const explanation = screen.getByLabelText("Pembahasan");
    await user.clear(explanation);
    await user.type(explanation, "Tambahkan.");
    await user.click(screen.getByLabelText("Jadikan pilihan C kunci jawaban"));
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));

    await waitFor(() => {
      expect(mocks.editQuestionAction).toHaveBeenCalledTimes(1);
    });
    expect(mocks.editQuestionAction).toHaveBeenCalledWith({
      questionId: QUESTION_ID,
      expectedRowVersion: 3,
      content: {
        ...initial,
        steps: initial.steps.map((textMd) => ({ textMd })),
        explanationMd: "Tambahkan.",
        correctLabel: "C",
      },
    });
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalledWith("/generate/abc");
    });
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("keeps an unsaved draft in sessionStorage and restores it", async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    const stem = screen.getByLabelText("Teks soal");
    await user.clear(stem);
    await user.type(stem, "Soal yang belum selesai");
    expect(JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "{}")).toMatchObject({
      stemMd: "Soal yang belum selesai",
      baseRowVersion: 3,
    });

    first.unmount();
    renderEditor();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Teks soal").value).toBe(
      "Soal yang belum selesai",
    );
    expect(screen.getByText("Draf yang belum tersimpan dipulihkan.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Buang draf" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Teks soal").value).toBe(
      initial.stemMd,
    );
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("does not store a draft that equals the saved question", async () => {
    const user = userEvent.setup();
    renderEditor();
    const explanation = screen.getByLabelText("Pembahasan");
    await user.type(explanation, "x");
    await user.type(explanation, "{Backspace}");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("works when sessionStorage is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalled();
    });
    vi.restoreAllMocks();
  });

  it("marks the fields with invalid math and keeps the draft", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({
      ok: false,
      reason: "invalid_math",
      fields: ["options.2.textMd"],
    });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));

    const field = await screen.findByLabelText("Teks pilihan C");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/Rumus di kolom ini tidak valid/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("rumus yang tidak valid");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });

  it("tells the teacher when the question changed elsewhere and offers a reload", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({ ok: false, reason: "stale" });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "sudah diubah di tempat lain",
    );
    await user.click(screen.getByRole("button", { name: "Muat ulang soal" }));
    expect(mocks.refresh).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("warns that an approved question goes back to review, and that a banked one is replaced", () => {
    const approved = renderEditor({ approved: true });
    expect(
      screen.getByText(/kembali ke peninjauan dan perlu disetujui lagi/),
    ).toBeTruthy();
    approved.unmount();
    renderEditor({ approved: true, banked: true });
    expect(screen.getByText(/Soal ini ada di Bank Soal/)).toBeTruthy();
  });

  it("disables saving until something changed, and while saving", async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => undefined;
    mocks.editQuestionAction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderEditor();
    const save = screen.getByRole("button", { name: "Simpan versi baru" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Menyimpan…" }).disabled,
    ).toBe(true);
    release({ ok: true, versionId: "v", status: "terverifikasi" });
    await waitFor(() => {
      expect(mocks.push).toHaveBeenCalled();
    });
  });

  it("throws the draft away when the teacher cancels on purpose", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    expect(window.sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(mocks.push).toHaveBeenCalledWith("/generate/abc");
    expect(mocks.editQuestionAction).not.toHaveBeenCalled();
  });

  it("shows the new server content, not an old draft, when the question moved on", async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), " draf");
    first.unmount();

    renderEditor({
      rowVersion: 4,
      initial: { ...initial, explanationMd: "Versi dari tempat lain." },
    });
    expect(screen.getByLabelText<HTMLTextAreaElement>("Pembahasan").value).toBe(
      "Versi dari tempat lain.",
    );
    expect(
      screen.getByText(/Draf ini dibuat pada versi soal yang lebih lama/),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Pakai draf" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Pembahasan").value).toBe(
      "Jumlahkan. draf",
    );
    expect(JSON.parse(window.sessionStorage.getItem(DRAFT_KEY) ?? "{}")).toMatchObject({
      baseRowVersion: 4,
    });
  });

  it("can discard an older draft", async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), " draf");
    first.unmount();
    renderEditor({ rowVersion: 4 });
    await user.click(screen.getByRole("button", { name: "Buang draf" }));
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(screen.queryByText(/lebih lama/)).toBeNull();
  });

  it("ignores a stored draft that is malformed", () => {
    window.sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        stemMd: "x",
        options: [1, 2, 3, 4],
        correctLabel: "Z",
        answerDisplayMd: 5,
        explanationMd: null,
        stepsText: "",
        baseRowVersion: 3,
      }),
    );
    renderEditor();
    expect(screen.getByLabelText<HTMLTextAreaElement>("Teks soal").value).toBe(
      initial.stemMd,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("moves focus to the first invalid field after a failed save", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({
      ok: false,
      reason: "invalid_math",
      fields: ["explanationMd", "options.2.textMd"],
    });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Teks pilihan C"));
    });
  });

  it("marks a step the server refuses by its row, described by its error", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({
      ok: false,
      reason: "invalid_math",
      fields: ["steps.1.textMd"],
    });
    renderEditor();
    await user.type(screen.getByLabelText("Langkah 2"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    const step = screen.getByLabelText("Langkah 2");
    await waitFor(() => {
      expect(step.getAttribute("aria-invalid")).toBe("true");
    });
    expect(document.activeElement).toBe(step);
    expect(
      document.getElementById(step.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/Rumus di kolom ini tidak valid/);
    expect(screen.getByLabelText("Langkah 1").getAttribute("aria-invalid")).toBeNull();
  });

  it("refuses an empty stem in the browser without calling the action", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.clear(screen.getByLabelText("Teks soal"));
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    const stem = screen.getByLabelText("Teks soal");
    await waitFor(() => {
      expect(stem.getAttribute("aria-invalid")).toBe("true");
    });
    expect(document.activeElement).toBe(stem);
    expect(screen.getByText("Isi teks soal.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Periksa kolom yang ditandai.");
    expect(mocks.editQuestionAction).not.toHaveBeenCalled();
    // Fixing the field clears its mark and the alert.
    await user.type(stem, "Soal baru");
    await waitFor(() => {
      expect(stem.getAttribute("aria-invalid")).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says which problem each field has: empty, or too long with the count", async () => {
    const user = userEvent.setup();
    renderEditor();
    // Empty: every required field has its own sentence.
    await user.clear(screen.getByLabelText("Teks pilihan C"));
    await user.clear(screen.getByLabelText("Jawaban akhir"));
    await user.clear(screen.getByLabelText("Pembahasan"));
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Teks pilihan C").getAttribute("aria-invalid")).toBe(
        "true",
      );
    });
    expect(screen.getByText("Isi teks pilihan C.")).toBeTruthy();
    expect(screen.getByText("Isi jawaban akhir.")).toBeTruthy();
    expect(screen.getByText("Isi pembahasan.")).toBeTruthy();
    expect(screen.queryByText(/kosong atau terlalu panjang/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Teks pilihan C"));
    expect(screen.getByRole("alert").textContent).toBe("Periksa kolom yang ditandai.");

    // Too long (a pasted text can pass maxLength in some browsers; set the value directly).
    fireEvent.change(screen.getByLabelText("Teks soal"), {
      target: { value: "x".repeat(1_300) },
    });
    fireEvent.change(screen.getByLabelText("Teks pilihan C"), {
      target: { value: "y".repeat(301) },
    });
    fireEvent.change(screen.getByLabelText("Jawaban akhir"), {
      target: { value: "z".repeat(310) },
    });
    fireEvent.change(screen.getByLabelText("Pembahasan"), {
      target: { value: "w".repeat(2_001) },
    });
    fireEvent.change(screen.getByLabelText("Langkah 2"), {
      target: { value: "v".repeat(501) },
    });
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    expect(
      await screen.findByText("Maksimal 1.200 karakter, sekarang 1.300."),
    ).toBeTruthy();
    expect(screen.getByText("Maksimal 300 karakter, sekarang 301.")).toBeTruthy();
    expect(screen.getByText("Maksimal 300 karakter, sekarang 310.")).toBeTruthy();
    expect(screen.getByText("Maksimal 2.000 karakter, sekarang 2.001.")).toBeTruthy();
    expect(screen.getByText("Maksimal 500 karakter, sekarang 501.")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Teks soal"));
    expect(mocks.editQuestionAction).not.toHaveBeenCalled();
  });

  it("explains a server refusal of an empty or long value the same way, and a math refusal as math", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({
      ok: false,
      reason: "invalid",
      fields: ["options.0.textMd"],
    });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    // Emptied after the browser check passed: the server answers with the field's path.
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Teks pilihan A").getAttribute("aria-invalid")).toBe(
        "true",
      );
    });
    // The value is valid (1 to 300 characters): the fallback sentence, not a wrong claim.
    expect(screen.getByText("Isian ini tidak valid.")).toBeTruthy();
  });

  it("marks the option the server refuses and focuses it", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({
      ok: false,
      reason: "invalid_math",
      fields: ["options.2.textMd"],
    });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    const option = screen.getByLabelText("Teks pilihan C");
    await waitFor(() => {
      expect(document.activeElement).toBe(option);
    });
    expect(option.getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the edits when the question is stale", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({ ok: false, reason: "stale" });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), " tambahan");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "sudah diubah di tempat lain",
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>("Pembahasan").value).toBe(
      "Jumlahkan. tambahan",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Simpan versi baru" })
        .disabled,
    ).toBe(false);
  });

  it("adds, removes and reorders steps, and saves them in that order", async () => {
    const user = userEvent.setup();
    renderEditor();
    const steps = (count: number) =>
      Array.from(
        { length: count },
        (_, i) =>
          screen.getByLabelText<HTMLTextAreaElement>("Langkah " + String(i + 1)).value,
      );
    await user.click(screen.getByRole("button", { name: "Tambah langkah" }));
    await user.type(screen.getByLabelText("Langkah 3"), "Periksa.");
    await user.click(screen.getByRole("button", { name: "Naikkan langkah 3" }));
    expect(steps(3)).toEqual(["Tulis soalnya.", "Periksa.", "Jumlahkan."]);
    await user.click(screen.getByRole("button", { name: "Turunkan langkah 1" }));
    expect(steps(3)).toEqual(["Periksa.", "Tulis soalnya.", "Jumlahkan."]);
    await user.click(screen.getByRole("button", { name: "Hapus langkah 1" }));
    expect(steps(2)).toEqual(["Tulis soalnya.", "Jumlahkan."]);
    expect(screen.queryByLabelText("Langkah 3")).toBeNull();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    await waitFor(() => {
      expect(mocks.editQuestionAction).toHaveBeenCalledTimes(1);
    });
    const [request] = mocks.editQuestionAction.mock.calls[0] as [
      { content: { steps: unknown } },
    ];
    expect(request.content.steps).toEqual([
      { textMd: "Tulis soalnya." },
      { textMd: "Jumlahkan." },
    ]);
  });

  it("limits the number of steps and has no move past either end", async () => {
    const user = userEvent.setup();
    renderEditor({
      initial: {
        ...initial,
        steps: Array.from({ length: 12 }, (_, i) => "Langkah isi " + String(i)),
      },
    });
    const button = (name: string) =>
      screen.getByRole<HTMLButtonElement>("button", { name });
    expect(button("Tambah langkah").disabled).toBe(true);
    expect(button("Naikkan langkah 1").disabled).toBe(true);
    expect(button("Turunkan langkah 12").disabled).toBe(true);
    await user.click(button("Hapus langkah 12"));
    expect(button("Tambah langkah").disabled).toBe(false);
  });

  it("compares a restored draft with the saved question, so saving stays possible and discarding resets", async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), " draf");
    first.unmount();
    renderEditor();
    expect(await screen.findByText("Draf yang belum tersimpan dipulihkan.")).toBeTruthy();
    const save = screen.getByRole<HTMLButtonElement>("button", {
      name: "Simpan versi baru",
    });
    expect(save.disabled).toBe(false);
    expect(window.sessionStorage.getItem(DRAFT_KEY)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Buang draf" }));
    expect(save.disabled).toBe(true);
  });

  it("does not apply a draft equal to the saved question", async () => {
    window.sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        ...initial,
        steps: initial.steps.map((textMd) => ({ textMd })),
        baseRowVersion: 3,
      }),
    );
    renderEditor();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a refused edit while the job runs", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({ ok: false, reason: "not_ready" });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    expect((await screen.findByRole("alert")).textContent).toContain("masih berjalan");
  });

  it("names a pending regeneration rather than generation", async () => {
    const user = userEvent.setup();
    mocks.editQuestionAction.mockResolvedValue({ ok: false, reason: "regenerating" });
    renderEditor();
    await user.type(screen.getByLabelText("Pembahasan"), "x");
    await user.click(screen.getByRole("button", { name: "Simpan versi baru" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("sedang dibuat ulang");
    expect(alert.textContent).not.toContain("Pembuatan soal masih berjalan");
  });
});
