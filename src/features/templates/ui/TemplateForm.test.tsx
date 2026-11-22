// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { renderWithIntl } from "@/test/intl";
import type { TemplateFormState, TemplateView } from "../schema/template";

const actions = vi.hoisted(() => ({
  save: vi.fn<
    (previous: TemplateFormState, data: FormData) => Promise<TemplateFormState>
  >(),
}));
vi.mock("../actions/save-template", () => ({ saveTemplateAction: actions.save }));
vi.mock("../actions/upload-logo", () => ({ uploadLogoAction: vi.fn() }));

import { TemplateForm } from "./TemplateForm";

const TEMPLATE: TemplateView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Kop utama",
  schoolName: "SMP Negeri 1 Surabaya",
  headerLines: ["Pemerintah Kota Surabaya"],
  subject: "Matematika",
  studentFields: ["name", "class"],
  defaultInstructions: null,
  paperSize: "A4",
  font: "times",
  isDefault: false,
  rowVersion: 3,
  hasLogo: false,
};

beforeEach(() => {
  actions.save.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

const save = () =>
  userEvent.click(screen.getByRole("button", { name: "Simpan templat" }));

describe("TemplateForm", () => {
  it("the letterhead preview follows typing in school name, header lines, subject, paper size and font", async () => {
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    const preview = screen.getByRole("figure", { name: "Pratinjau kop" });
    const school = screen.getByLabelText("Nama sekolah");
    await userEvent.clear(school);
    await userEvent.type(school, "SMP 9");
    expect(within(preview).getByText("SMP 9")).toBeTruthy();

    const line = screen.getByLabelText("Baris kop 2");
    await userEvent.type(line, "Jl. Merdeka 1");
    expect(within(preview).getByText("Jl. Merdeka 1")).toBeTruthy();

    const subject = screen.getByLabelText("Mata pelajaran");
    await userEvent.clear(subject);
    await userEvent.type(subject, "Fisika");
    expect(within(preview).getByText(/Fisika/)).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText("Ukuran kertas"), "F4");
    await userEvent.selectOptions(screen.getByLabelText("Huruf"), "arial");
    expect(screen.getByText("F4 (215 × 330 mm) · Arial 12 pt")).toBeTruthy();
    expect(preview.getAttribute("style")).toContain("Arial");
  });

  it("checks in the browser like the server: an empty name is refused, the action is not called and focus goes to it", async () => {
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    const name = screen.getByLabelText("Nama templat");
    await userEvent.clear(name);
    await save();
    expect((await screen.findByText("Wajib diisi.")).id).toBe(
      (name.getAttribute("aria-describedby") ?? "").split(" ")[0],
    );
    expect(actions.save).not.toHaveBeenCalled();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(name);
  });

  it("focus goes to the first invalid field when several are wrong", async () => {
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    await userEvent.clear(screen.getByLabelText("Nama sekolah"));
    await userEvent.clear(screen.getByLabelText("Nama templat"));
    await save();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText("Nama templat"));
    });
    expect(screen.getAllByText("Wajib diisi.")).toHaveLength(2);
  });

  it("clears a field's error once it is valid, live after a failed submit", async () => {
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    const name = screen.getByLabelText("Nama templat");
    await userEvent.clear(name);
    await save();
    await screen.findByText("Wajib diisi.");
    await userEvent.type(name, "Kop baru");
    await waitFor(() => {
      expect(screen.queryByText("Wajib diisi.")).toBeNull();
    });
  });

  it("posts the template id, the row version and the visible values", async () => {
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Tanggal"));
    await save();
    await waitFor(() => {
      expect(actions.save).toHaveBeenCalledTimes(1);
    });
    const sent = actions.save.mock.calls[0][1];
    expect(sent.get("templateId")).toBe(TEMPLATE.id);
    expect(sent.get("expectedRowVersion")).toBe("3");
    expect(sent.get("name")).toBe("Kop utama");
    expect(sent.get("headerLine0")).toBe("Pemerintah Kota Surabaya");
    expect(sent.getAll("studentFields")).toEqual(["name", "class", "date"]);
    expect(sent.get("paperSize")).toBe("A4");
    expect(sent.has("isDefault")).toBe(false);
  });

  it("posts a checked isDefault", async () => {
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /jadikan/i }));
    await save();
    await waitFor(() => {
      expect(actions.save).toHaveBeenCalledTimes(1);
    });
    expect(actions.save.mock.calls[0][1].get("isDefault")).toBe("on");
  });

  it("a stale row version from the server shows the stale message and keeps input", async () => {
    actions.save.mockResolvedValue({ error: "conflict" });
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    const school = screen.getByLabelText<HTMLInputElement>("Nama sekolah");
    await userEvent.clear(school);
    await userEvent.type(school, "SMP 9");
    await save();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Templat ini baru saja diubah di tempat lain. Muat ulang halaman, lalu coba lagi.",
    );
    expect(school.value).toBe("SMP 9");
  });

  it("saved calls onSaved once with the template id", async () => {
    actions.save.mockResolvedValue({ savedAt: 1, templateId: TEMPLATE.id });
    const onSaved = vi.fn();
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={onSaved} />);
    await save();
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(onSaved).toHaveBeenCalledWith("Templat sudah disimpan.", TEMPLATE.id);
  });

  it("shows a server error on a header line at that line and focuses it", async () => {
    actions.save.mockResolvedValue({ fieldErrors: { headerLine2: "tooLong" } });
    renderWithIntl(<TemplateForm template={TEMPLATE} onSaved={vi.fn()} />);
    await save();
    const line = screen.getByLabelText("Baris kop 3");
    await waitFor(() => {
      expect(document.activeElement).toBe(line);
    });
    expect(line.getAttribute("aria-invalid")).toBe("true");
  });

  it("has no axe violations after a failed submit (colour contrast excluded)", async () => {
    const { container } = renderWithIntl(
      <TemplateForm template={null} onSaved={vi.fn()} />,
    );
    await save();
    await screen.findAllByText("Wajib diisi.");
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
