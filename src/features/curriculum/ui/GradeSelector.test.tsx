// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import userEvent from "@testing-library/user-event";
import { GradeSelector } from "./GradeSelector";

afterEach(cleanup);

describe("GradeSelector", () => {
  it("shows three grades in a group named Kelas with Grade 8 selected", () => {
    renderWithIntl(<GradeSelector />);
    expect(screen.getByRole("group", { name: "Kelas" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Kelas 8/ }).checked).toBe(
      true,
    );
  });

  it("disables Grades 7 and 9 and labels them Segera in text", () => {
    renderWithIntl(<GradeSelector />);
    for (const grade of ["7", "9"]) {
      const radio = screen.getByRole("radio", { name: new RegExp(`Kelas ${grade}`) });
      expect((radio as HTMLInputElement).disabled).toBe(true);
      expect(radio.closest("div")?.textContent).toContain("Segera");
    }
    expect(
      screen.getByRole("radio", { name: /Kelas 8/ }).closest("div")?.textContent,
    ).not.toContain("Segera");
  });

  it("keeps Grade 8 selected when a disabled grade is clicked", async () => {
    renderWithIntl(<GradeSelector />);
    await userEvent.click(screen.getByText("Kelas 7"));
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Kelas 8/ }).checked).toBe(
      true,
    );
  });

  it("puts only Grade 8 in the tab order (7 and 9 are not focusable)", async () => {
    renderWithIntl(<GradeSelector />);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Kelas 8/ }));
    await userEvent.tab();
    expect(document.activeElement).not.toBe(
      screen.getByRole("radio", { name: /Kelas 7/ }),
    );
    expect(document.activeElement).not.toBe(
      screen.getByRole("radio", { name: /Kelas 9/ }),
    );
    expect(document.activeElement).toBe(document.body);
  });

  it("exposes the selected grade with a visible selected style and 52 px choices", () => {
    renderWithIntl(<GradeSelector />);
    const radio = screen.getByRole<HTMLInputElement>("radio", { name: /Kelas 8/ });
    expect(radio.checked).toBe(true);
    const label = document.querySelector(`label[for="${radio.id}"]`)!;
    expect(label.className).toContain("peer-checked:bg-primary");
    expect(label.className).toContain("min-h-13");
  });

  it("does not post a grade itself: the form carries the grade field", () => {
    renderWithIntl(<GradeSelector />);
    for (const radio of screen.getAllByRole<HTMLInputElement>("radio")) {
      expect(radio.name).not.toBe("grade");
    }
  });
});
