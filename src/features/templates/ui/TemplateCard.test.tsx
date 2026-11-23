// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { LogoFormState, TemplateFormState, TemplateView } from "../schema/template";

const actions = vi.hoisted(() => ({
  save: vi.fn<
    (previous: TemplateFormState, data: FormData) => Promise<TemplateFormState>
  >(),
  setDefault:
    vi.fn<(id: string) => Promise<{ ok: true } | { ok: false; reason: string }>>(),
  upload: vi.fn<(previous: LogoFormState, data: FormData) => Promise<LogoFormState>>(),
}));
vi.mock("../actions/save-template", () => ({ saveTemplateAction: actions.save }));
vi.mock("../actions/set-default-template", () => ({
  setDefaultTemplateAction: actions.setDefault,
}));
vi.mock("../actions/upload-logo", () => ({ uploadLogoAction: actions.upload }));
const trash = vi.hoisted(() => ({ action: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: trash.refresh }) }));
vi.mock("@/features/trash/actions/template", () => ({
  trashTemplateAction: trash.action,
}));

import { LetterheadPreview } from "./LetterheadPreview";
import { TemplateCard } from "./TemplateCard";

const TEMPLATE: TemplateView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Kop utama",
  schoolName: "SMP Negeri 1 Surabaya",
  headerLines: ["Pemerintah Kota Surabaya", "Dinas Pendidikan"],
  subject: "Matematika",
  studentFields: ["name", "class"],
  defaultInstructions: null,
  paperSize: "A4",
  font: "times",
  isDefault: true,
  rowVersion: 3,
  hasLogo: true,
};
const SECOND: TemplateView = {
  ...TEMPLATE,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Kop ujian",
  isDefault: false,
  hasLogo: false,
};

beforeEach(() => {
  actions.save.mockReset().mockResolvedValue({});
  actions.setDefault.mockReset().mockResolvedValue({ ok: true });
  actions.upload.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe("LetterheadPreview", () => {
  it("shows the header lines, the school name and the logo from the owner-checked route", () => {
    renderWithIntl(
      <LetterheadPreview
        schoolName="SMP Negeri 1 Surabaya"
        headerLines={["Pemerintah Kota Surabaya", "Dinas Pendidikan"]}
        subject="Matematika"
        font="times"
        paperSize="A4"
        logoSrc="/api/templates/x/logo?v=3"
      />,
    );
    const preview = screen.getByRole("figure", { name: "Pratinjau kop" });
    expect(within(preview).getByText("SMP Negeri 1 Surabaya")).toBeTruthy();
    expect(within(preview).getByText("Pemerintah Kota Surabaya")).toBeTruthy();
    expect(within(preview).getByText("Dinas Pendidikan")).toBeTruthy();
    expect(within(preview).getByText(/Matematika/)).toBeTruthy();
    const logo = within(preview).getByRole("img", { name: "Logo sekolah" });
    expect(logo.getAttribute("src")).toBe("/api/templates/x/logo?v=3");
  });

  it("shows a placeholder instead of an empty school name and no image without a logo", () => {
    renderWithIntl(
      <LetterheadPreview
        schoolName="  "
        headerLines={[]}
        subject="Matematika"
        font="arial"
        paperSize="F4"
        logoSrc={null}
      />,
    );
    expect(screen.getByText("Nama sekolah")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("TemplateCard", () => {
  it("offers a new-template form when there is none yet", () => {
    renderWithIntl(<TemplateCard templates={[]} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Templat dokumen" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Belum ada templat. Buat yang pertama di bawah ini."),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Nama templat").value).toBe("");
    expect(screen.getByLabelText<HTMLInputElement>("Mata pelajaran").value).toBe(
      "Matematika",
    );
    // No logo before the template exists.
    expect(screen.queryByLabelText("Logo sekolah")).toBeNull();
    expect(screen.getByText("Simpan templat dulu, lalu unggah logonya.")).toBeTruthy();
  });

  it("lists the templates with the default marked and lets another become the default", async () => {
    renderWithIntl(<TemplateCard templates={[TEMPLATE, SECOND]} />);
    const list = screen.getByRole("list", { name: "Daftar templat" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Default")).toBeTruthy();
    expect(
      within(items[0]).queryByRole("button", { name: /Jadikan default/ }),
    ).toBeNull();
    await userEvent.click(
      within(items[1]).getByRole("button", { name: "Jadikan default: Kop ujian" }),
    );
    await waitFor(() => {
      expect(actions.setDefault).toHaveBeenCalledWith(SECOND.id);
    });
  });

  it("moves a template to the trash behind a confirmation that says what it means", async () => {
    Object.assign(HTMLDialogElement.prototype, {
      showModal(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
      close(this: HTMLDialogElement) {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
      },
    });
    trash.action.mockResolvedValue({ ok: false, reason: "not_found" });
    renderWithIntl(<TemplateCard templates={[TEMPLATE, SECOND]} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Pindahkan ke Sampah: Kop ujian" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Pindahkan templat ke Sampah?" });
    expect(dialog.textContent).toContain(
      "Asesmen yang memakainya tidak bisa disetujui sampai Anda memilih templat lain.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Pindahkan ke Sampah" }),
    );
    expect(trash.action).toHaveBeenCalledWith({ id: SECOND.id });
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Templat ini sudah tidak ada di sini. Muat ulang halaman.",
    );
  });

  it("selects the first template left when the selected one leaves the list", async () => {
    const view = renderWithIntl(<TemplateCard templates={[TEMPLATE, SECOND]} />);
    await userEvent.click(screen.getByRole("button", { name: "Ubah: Kop ujian" }));
    view.rerender(<TemplateCard templates={[TEMPLATE]} />);
    expect(
      screen
        .getByRole("button", { name: "Ubah: Kop utama" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps the status region mounted before any notice, so the first one is announced", () => {
    renderWithIntl(<TemplateCard templates={[TEMPLATE]} />);
    // The card's notice and the logo form's own status line.
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status.textContent).toBe("");
      // Not display:none while empty: some screen readers ignore a region that appears later.
      expect(status.className).not.toMatch(/hidden/);
    }
  });

  it("says the session ended when making a default fails for that reason", async () => {
    actions.setDefault.mockResolvedValue({ ok: false, reason: "unauthenticated" });
    renderWithIntl(<TemplateCard templates={[TEMPLATE, SECOND]} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Jadikan default: Kop ujian" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.",
    );
  });

  it("edits the chosen template with its row version, and the preview follows the typing", async () => {
    renderWithIntl(<TemplateCard templates={[TEMPLATE, SECOND]} />);
    // The default one is open first.
    const school = screen.getByLabelText<HTMLInputElement>("Nama sekolah");
    expect(school.value).toBe("SMP Negeri 1 Surabaya");
    await userEvent.clear(school);
    await userEvent.type(school, "SMP Negeri 9");
    const preview = screen.getByRole("figure", { name: "Pratinjau kop" });
    expect(within(preview).getByText("SMP Negeri 9")).toBeTruthy();
    expect(
      within(preview).getByRole("img", { name: "Logo sekolah" }).getAttribute("src"),
    ).toBe(`/api/templates/${TEMPLATE.id}/logo?v=3`);

    await userEvent.click(screen.getByRole("button", { name: "Simpan templat" }));
    await waitFor(() => {
      expect(actions.save).toHaveBeenCalled();
    });
    const sent = actions.save.mock.calls[0][1];
    expect(sent.get("templateId")).toBe(TEMPLATE.id);
    expect(sent.get("expectedRowVersion")).toBe("3");
    expect(sent.get("schoolName")).toBe("SMP Negeri 9");
    expect(sent.getAll("studentFields")).toEqual(["name", "class"]);
  });

  it("ties a field error to its input and focuses it", async () => {
    actions.save.mockResolvedValue({ fieldErrors: { schoolName: "required" } });
    renderWithIntl(<TemplateCard templates={[TEMPLATE]} />);
    await userEvent.click(screen.getByRole("button", { name: "Simpan templat" }));
    const school = await screen.findByLabelText("Nama sekolah");
    await waitFor(() => {
      expect(school.getAttribute("aria-invalid")).toBe("true");
    });
    expect(document.activeElement).toBe(school);
    const errorId = school.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(errorId.split(" ")[0])?.textContent).toBe(
      "Wajib diisi.",
    );
  });

  it("says when the template changed elsewhere", async () => {
    actions.save.mockResolvedValue({ error: "conflict" });
    renderWithIntl(<TemplateCard templates={[TEMPLATE]} />);
    await userEvent.click(screen.getByRole("button", { name: "Simpan templat" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Templat ini baru saja diubah di tempat lain. Muat ulang halaman, lalu coba lagi.",
    );
  });

  it("uploads a logo for a saved template and refuses a file above 1 MB in the browser", async () => {
    renderWithIntl(<TemplateCard templates={[TEMPLATE]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Logo sekolah");
    expect(input.getAttribute("accept")).toBe("image/png,image/jpeg");
    expect(
      screen.getByText("PNG atau JPG, paling besar 1 MB.", { exact: false }),
    ).toBeTruthy();
    const big = new File([new Uint8Array(1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });
    await userEvent.upload(input, big);
    await userEvent.click(screen.getByRole("button", { name: "Unggah logo" }));
    expect((await screen.findByText("Ukuran logo paling besar 1 MB.")).id).toBeTruthy();
    expect(actions.upload).not.toHaveBeenCalled();

    const small = new File([new Uint8Array(10)], "logo.png", { type: "image/png" });
    await userEvent.upload(input, small);
    await userEvent.click(screen.getByRole("button", { name: "Unggah logo" }));
    await waitFor(() => {
      expect(actions.upload).toHaveBeenCalled();
    });
    expect(actions.upload.mock.calls[0][1].get("templateId")).toBe(TEMPLATE.id);
  });

  it("says in a status line next to the button when the logo was uploaded", async () => {
    actions.upload.mockResolvedValue({ savedAt: 1 });
    renderWithIntl(<TemplateCard templates={[TEMPLATE]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Logo sekolah");
    const form = input.closest("form");
    if (!form) throw new Error("the logo form is missing");
    expect(within(form).getByRole("status").textContent).toBe("");
    await userEvent.upload(
      input,
      new File([new Uint8Array(10)], "logo.png", { type: "image/png" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Unggah logo" }));
    await waitFor(() => {
      expect(within(form).getByRole("status").textContent).toBe("Logo sudah diunggah.");
    });
    // Picking another file clears the old confirmation.
    await userEvent.upload(
      input,
      new File([new Uint8Array(10)], "other.png", { type: "image/png" }),
    );
    expect(within(form).getByRole("status").textContent).toBe("");
  });

  it("refuses an SVG in the browser with a clear message and sends nothing", async () => {
    // Some browsers offer "all files" in the picker even with accept set.
    const user = userEvent.setup({ applyAccept: false });
    renderWithIntl(<TemplateCard templates={[TEMPLATE]} />);
    const input = screen.getByLabelText<HTMLInputElement>("Logo sekolah");
    await user.upload(input, new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }));
    await user.click(screen.getByRole("button", { name: "Unggah logo" }));
    expect(
      (await screen.findByText("Logo SVG tidak diterima. Gunakan PNG atau JPG.")).id,
    ).toBeTruthy();
    expect(actions.upload).not.toHaveBeenCalled();
    // A file named .svg is refused even when the browser reports no type.
    await user.upload(input, new File(["<svg/>"], "kop.SVG", { type: "" }));
    await user.click(screen.getByRole("button", { name: "Unggah logo" }));
    expect(actions.upload).not.toHaveBeenCalled();
  });

  it("explains that a stored SVG logo stays but is left out of PDF and Word", () => {
    renderWithIntl(<TemplateCard templates={[{ ...TEMPLATE, logoIsSvg: true }]} />);
    expect(
      screen.getByText(
        /Logo yang tersimpan berformat SVG.*tidak muncul di berkas PDF dan Word/,
      ),
    ).toBeTruthy();
    cleanup();
    renderWithIntl(<TemplateCard templates={[TEMPLATE]} />);
    expect(screen.queryByText(/berformat SVG/)).toBeNull();
  });
});
