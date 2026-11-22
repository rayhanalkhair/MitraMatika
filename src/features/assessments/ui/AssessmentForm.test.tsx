// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import { parseAssessmentForm, type AssessmentFormState } from "../schema/assessment";

const mocks = vi.hoisted(() => ({
  create: vi.fn<
    (previous: AssessmentFormState, data: FormData) => Promise<AssessmentFormState>
  >(() => Promise.resolve({})),
  update: vi.fn<
    (previous: AssessmentFormState, data: FormData) => Promise<AssessmentFormState>
  >(() => Promise.resolve({})),
}));
vi.mock("../actions/create-assessment", () => ({ createAssessmentAction: mocks.create }));
vi.mock("../actions/update-assessment", () => ({ updateAssessmentAction: mocks.update }));

import { AssessmentForm } from "./AssessmentForm";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const TEMPLATES = [
  { id: T1, name: "Kop SMP 1", isDefault: false },
  { id: T2, name: "Kop utama", isDefault: true },
];

describe("AssessmentForm (create)", () => {
  it("has only the fields of a new assessment and names the default template", () => {
    renderWithIntl(<AssessmentForm templates={TEMPLATES} />);
    expect(screen.getByLabelText("Judul")).toBeTruthy();
    expect(screen.getByLabelText("Jenis")).toBeTruthy();
    expect(screen.getByLabelText("Kelas")).toBeTruthy();
    expect(screen.queryByLabelText("Durasi (menit)")).toBeNull();
    expect(screen.getByRole("option", { name: "Kop utama (default)" })).toBeTruthy();
  });

  it("posts the chosen fields", async () => {
    renderWithIntl(<AssessmentForm templates={TEMPLATES} />);
    await userEvent.type(screen.getByLabelText("Judul"), "Ulangan SPLDV");
    await userEvent.selectOptions(screen.getByLabelText("Jenis"), "sts");
    await userEvent.selectOptions(screen.getByLabelText("Templat dokumen"), T1);
    await userEvent.click(screen.getByRole("button", { name: "Buat asesmen" }));
    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledTimes(1);
    });
    const data = mocks.create.mock.calls[0][1];
    expect(data.get("title")).toBe("Ulangan SPLDV");
    expect(data.get("kind")).toBe("sts");
    expect(data.get("grade")).toBe("8");
    expect(data.get("templateId")).toBe(T1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses an empty title in the browser, ties the error to the field and focuses it", async () => {
    renderWithIntl(<AssessmentForm templates={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Buat asesmen" }));
    const title = screen.getByLabelText("Judul");
    const error = await screen.findByText("Wajib diisi.");
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(error.id).toBe((title.getAttribute("aria-describedby") ?? "").split(" ")[0]);
    expect(document.activeElement).toBe(title);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("shows a server field error on its field and keeps what was typed", async () => {
    mocks.create.mockResolvedValueOnce({ fieldErrors: { title: "tooLong" } });
    renderWithIntl(<AssessmentForm templates={[]} />);
    const title = screen.getByLabelText<HTMLInputElement>("Judul");
    await userEvent.type(title, "Ulangan");
    await userEvent.click(screen.getByRole("button", { name: "Buat asesmen" }));
    expect(await screen.findByText("Terlalu panjang.")).toBeTruthy();
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(title.value).toBe("Ulangan");
    await waitFor(() => {
      expect(document.activeElement).toBe(title);
    });
  });

  it("shows a form-level error as an alert", async () => {
    mocks.create.mockResolvedValueOnce({ error: "templateNotFound" });
    renderWithIntl(<AssessmentForm templates={[]} />);
    await userEvent.type(screen.getByLabelText("Judul"), "Ulangan");
    await userEvent.click(screen.getByRole("button", { name: "Buat asesmen" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Templat yang dipilih sudah tidak ada.",
    );
  });
});

describe("AssessmentForm (edit)", () => {
  const existing = {
    title: "Ulangan",
    kind: "latihan",
    grade: 8,
    templateId: T1,
    examDate: "2026-12-01",
    durationMinutes: 60,
    instructions: "Teliti.",
  };

  it("shows every detail and posts the id and the row version it was given", async () => {
    renderWithIntl(
      <AssessmentForm
        templates={TEMPLATES}
        existing={existing}
        assessmentId="a1"
        rowVersion={4}
      />,
    );
    expect(screen.getByLabelText<HTMLInputElement>("Durasi (menit)").value).toBe("60");
    expect(screen.getByLabelText<HTMLInputElement>("Tanggal").value).toBe("2026-12-01");
    expect(screen.getByLabelText<HTMLSelectElement>("Templat dokumen").value).toBe(T1);
    await userEvent.click(screen.getByRole("button", { name: "Simpan detail" }));
    const data = mocks.update.mock.calls[0][1];
    expect(data.get("assessmentId")).toBe("a1");
    expect(data.get("expectedRowVersion")).toBe("4");
    expect(data.get("instructions")).toBe("Teliti.");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("falls back to no template when the saved one is no longer an option, in the field and in the post", async () => {
    renderWithIntl(
      <AssessmentForm
        templates={[TEMPLATES[1]]}
        existing={existing}
        assessmentId="a1"
        rowVersion={4}
      />,
    );
    expect(screen.getByLabelText<HTMLSelectElement>("Templat dokumen").value).toBe("");
    await userEvent.click(screen.getByRole("button", { name: "Simpan detail" }));
    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledTimes(1);
    });
    expect(mocks.update.mock.calls[0][1].get("templateId")).toBe("");
  });

  it("announces a save and a conflict", async () => {
    mocks.update.mockResolvedValueOnce({ savedAt: 1 });
    renderWithIntl(
      <AssessmentForm
        templates={[]}
        existing={existing}
        assessmentId="a1"
        rowVersion={4}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Simpan detail" }));
    expect((await screen.findByText("Detail disimpan.")).getAttribute("role")).toBe(
      "status",
    );
    mocks.update.mockResolvedValueOnce({ error: "conflict" });
    await userEvent.click(screen.getByRole("button", { name: "Simpan detail" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "sudah diubah di tempat lain",
    );
  });

  it("create mode validates four fields, edit mode seven", async () => {
    renderWithIntl(<AssessmentForm templates={[]} />);
    expect(screen.queryByLabelText("Durasi (menit)")).toBeNull();
    await userEvent.type(screen.getByLabelText("Judul"), "Ulangan");
    await userEvent.click(screen.getByRole("button", { name: "Buat asesmen" }));
    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledTimes(1);
    });
    cleanup();

    renderWithIntl(
      <AssessmentForm
        templates={[]}
        existing={existing}
        assessmentId="a1"
        rowVersion={4}
      />,
    );
    const duration = screen.getByLabelText("Durasi (menit)");
    await userEvent.clear(duration);
    await userEvent.type(duration, "0");
    await userEvent.click(screen.getByRole("button", { name: "Simpan detail" }));
    expect(await screen.findByText("Isi dengan nilai yang valid.")).toBeTruthy();
    expect(duration.getAttribute("aria-invalid")).toBe("true");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty title", "Judul", "title", "", "Wajib diisi."],
    [
      "a duration of 0",
      "Durasi (menit)",
      "durationMinutes",
      "0",
      "Isi dengan nilai yang valid.",
    ],
    [
      "an instruction over the limit",
      "Petunjuk pengerjaan",
      "instructions",
      "x".repeat(2001),
      "Terlalu panjang.",
    ],
  ])("client and server agree: %s", async (_name, label, field, value, message) => {
    renderWithIntl(
      <AssessmentForm
        templates={[]}
        existing={existing}
        assessmentId="a1"
        rowVersion={4}
      />,
    );
    // fireEvent: a typed value would stop at the field's maxLength.
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await userEvent.click(screen.getByRole("button", { name: "Simpan detail" }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(mocks.update).not.toHaveBeenCalled();

    // The server refuses the same value, on the same field.
    const data = new FormData();
    const posted = {
      title: "Ulangan",
      kind: "latihan",
      grade: "8",
      templateId: "",
      examDate: "",
      durationMinutes: "",
      instructions: "",
      [field]: value,
    };
    for (const [key, v] of Object.entries(posted)) data.append(key, v);
    const parsed = parseAssessmentForm(data);
    expect(!parsed.ok && Object.keys(parsed.error)).toEqual([field]);
  });

  it("keeps the saved notice after a save remounts the form, and tells the editor before the action runs", async () => {
    const order: string[] = [];
    mocks.update.mockImplementationOnce(() => {
      order.push("action");
      return Promise.resolve({ savedAt: 1 });
    });
    const onSubmitted = vi.fn(() => {
      order.push("submitted");
    });
    const props = {
      templates: [],
      existing,
      assessmentId: "a1",
      rowVersion: 4,
    };
    const { rerender } = renderWithIntl(
      <AssessmentForm {...props} onSubmitted={onSubmitted} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Simpan detail" }));
    await waitFor(() => {
      expect(order).toEqual(["submitted", "action"]);
    });
    // The editor remounts the form on the new row version and passes the notice down.
    rerender(<AssessmentForm key={5} {...props} rowVersion={5} savedNotice />);
    expect((await screen.findByText("Detail disimpan.")).getAttribute("role")).toBe(
      "status",
    );
  });

  it("disabled locks every field and the button", () => {
    renderWithIntl(
      <AssessmentForm
        templates={TEMPLATES}
        existing={existing}
        assessmentId="a1"
        rowVersion={4}
        disabled
      />,
    );
    for (const label of [
      "Judul",
      "Jenis",
      "Kelas",
      "Templat dokumen",
      "Tanggal",
      "Durasi (menit)",
      "Petunjuk pengerjaan",
    ]) {
      expect(
        screen.getByLabelText<HTMLInputElement>(label).disabled,
        `${label} is locked`,
      ).toBe(true);
    }
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Simpan detail" }).disabled,
    ).toBe(true);
  });

  it("is read-only while disabled", () => {
    renderWithIntl(
      <AssessmentForm
        templates={[]}
        existing={existing}
        assessmentId="a1"
        rowVersion={4}
        disabled
      />,
    );
    expect(screen.getByLabelText<HTMLInputElement>("Judul").disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Simpan detail" }).disabled,
    ).toBe(true);
  });
});
