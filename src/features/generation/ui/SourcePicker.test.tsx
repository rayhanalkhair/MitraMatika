// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import type { GenerationMaterial } from "@/features/generation/service/material-selection";
import { FormProvider, useForm } from "react-hook-form";
import {
  generationFormDefaults,
  type GenerationFormValues,
} from "@/features/generation/schema/request-input";
import { SourcePicker } from "./SourcePicker";

afterEach(cleanup);

const MATERIALS: GenerationMaterial[] = [
  {
    id: "m1",
    title: "Buku SPLDV",
    pageCount: 12,
    sections: [
      { id: "s1", title: "Bab 1 Persamaan", pageStart: 1, pageEnd: 5 },
      { id: "s2", title: "Bab 2 SPLDV", pageStart: 6, pageEnd: 12 },
    ],
  },
  { id: "m2", title: "Lembar kerja", pageCount: 3, sections: [] },
];

// What the form would submit.
function submitted(container: HTMLElement): [string, string][] {
  const form = container.querySelector("form");
  if (!form) throw new Error("no form");
  return [...new FormData(form).entries()].map(([k, v]) => [
    k,
    typeof v === "string" ? v : v.name,
  ]);
}

// The picker lives inside the generation form's React Hook Form provider.
function Harness({
  materials,
  error,
  truncated,
}: {
  materials: GenerationMaterial[];
  error?: string;
  truncated?: boolean;
}) {
  const form = useForm<GenerationFormValues>({
    defaultValues: generationFormDefaults(null),
  });
  return (
    <FormProvider {...form}>
      <form>
        <SourcePicker
          materials={materials}
          truncated={truncated}
          errorId={error ? "error-material" : undefined}
        />
        {error && <p id="error-material">{error}</p>}
      </form>
    </FormProvider>
  );
}

function renderPicker(materials = MATERIALS, error?: string) {
  return renderWithIntl(<Harness materials={materials} error={error} />);
}

describe("SourcePicker", () => {
  it("starts on the curriculum topic and sends no material", () => {
    const { container } = renderPicker();
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: "Topik kurikulum" }).checked,
    ).toBe(true);
    expect(submitted(container)).toEqual([["source", "topic"]]);
  });

  it('shows the material helper only for "Dari materi", never for the curriculum topic', async () => {
    const user = userEvent.setup();
    const { container } = renderPicker();
    expect(container.textContent).not.toContain("halaman materi yang Anda pilih");
    await user.click(screen.getByRole("radio", { name: "Dari materi" }));
    expect(container.textContent).toContain("halaman materi yang Anda pilih");
    await user.click(screen.getByRole("radio", { name: "Topik kurikulum" }));
    expect(container.textContent).not.toContain("halaman materi yang Anda pilih");
  });

  it("chooses a material, then the whole document, chapters or pages", async () => {
    const user = userEvent.setup();
    const { container } = renderPicker();
    await user.click(screen.getByRole("radio", { name: "Dari materi" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Materi" }), "m1");
    expect(submitted(container)).toEqual([
      ["source", "material"],
      ["materialId", "m1"],
      ["materialScope", "all"],
    ]);

    await user.click(screen.getByRole("radio", { name: "Bab" }));
    await user.click(screen.getByRole("checkbox", { name: /Bab 2 SPLDV/ }));
    expect(submitted(container)).toEqual([
      ["source", "material"],
      ["materialId", "m1"],
      ["materialScope", "sections"],
      ["sectionIds", "s2"],
    ]);

    await user.click(screen.getByRole("radio", { name: "Halaman" }));
    const pages = screen.getByRole("textbox", { name: "Halaman" });
    expect(pages.getAttribute("aria-describedby")).toBeTruthy();
    expect(container.textContent).toContain("Dokumen ini punya 12 halaman.");
    await user.type(pages, "2-4");
    expect(submitted(container)).toContainEqual(["pages", "2-4"]);
    expect(submitted(container)).toContainEqual(["materialScope", "pages"]);
  });

  it("starts with the topic checked in the server render, before React Hook Form runs", () => {
    renderPicker();
    expect(
      screen
        .getByRole<HTMLInputElement>("radio", { name: "Topik kurikulum" })
        .hasAttribute("checked"),
    ).toBe(true);
  });

  it("keeps the chapter choice when the scope changes and comes back", async () => {
    const user = userEvent.setup();
    const { container } = renderPicker();
    await user.click(screen.getByRole("radio", { name: "Dari materi" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Materi" }), "m1");
    await user.click(screen.getByRole("radio", { name: "Bab" }));
    await user.click(screen.getByRole("checkbox", { name: /Bab 1 Persamaan/ }));
    await user.click(screen.getByRole("radio", { name: "Halaman" }));
    expect(submitted(container)).not.toContainEqual(["sectionIds", "s1"]);
    await user.click(screen.getByRole("radio", { name: "Bab" }));
    expect(submitted(container)).toContainEqual(["sectionIds", "s1"]);
  });

  it("explains a material without chapters", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("radio", { name: "Dari materi" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Materi" }), "m2");
    await user.click(screen.getByRole("radio", { name: "Bab" }));
    expect(screen.getByText(/belum punya bab/)).toBeTruthy();
  });

  it("offers no material source when nothing is ready, with a way to the materials", () => {
    renderPicker([]);
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: "Dari materi" }).disabled,
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Buka Materi" }).getAttribute("href")).toBe(
      "/materials",
    );
  });

  it("marks the chapter checkboxes invalid with the chapter error", async () => {
    const user = userEvent.setup();
    renderPicker(MATERIALS, "Pilih minimal satu bab.");
    await user.click(screen.getByRole("radio", { name: "Dari materi" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Materi" }), "m1");
    await user.click(screen.getByRole("radio", { name: "Bab" }));
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.getAttribute("aria-invalid")).toBe("true");
      expect(box.getAttribute("aria-describedby")).toContain("error-material");
    }
  });

  it("says when only the newest materials are listed", async () => {
    const user = userEvent.setup();
    renderWithIntl(<Harness materials={MATERIALS} truncated />);
    await user.click(screen.getByRole("radio", { name: "Dari materi" }));
    expect(screen.getByText(/100 materi terbaru/)).toBeTruthy();
  });

  it("ties the material error to the controls", async () => {
    const user = userEvent.setup();
    renderPicker(MATERIALS, "Pilih materi terlebih dahulu.");
    await user.click(screen.getByRole("radio", { name: "Dari materi" }));
    expect(
      screen.getByRole("combobox", { name: "Materi" }).getAttribute("aria-describedby"),
    ).toContain("error-material");
    expect(
      screen.getByRole("combobox", { name: "Materi" }).getAttribute("aria-invalid"),
    ).toBe("true");
  });
});
