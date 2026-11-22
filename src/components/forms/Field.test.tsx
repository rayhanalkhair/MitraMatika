// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Field } from "./Field";
import { FormError } from "./FormError";

afterEach(cleanup);

describe("Field", () => {
  it("labels its control and ties the error, then the hint, with aria-describedby", () => {
    render(
      <Field id="kind" label="Jenis" hint="Pilih satu." error="Isian ini tidak valid.">
        {(a11y) => (
          <select id="kind" name="kind" {...a11y}>
            <option value="latihan">Latihan</option>
          </select>
        )}
      </Field>,
    );
    const select = screen.getByLabelText("Jenis");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    const texts = (select.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(["Isian ini tidak valid.", "Pilih satu."]);
  });

  it("passes no aria attributes without an error or a hint", () => {
    render(
      <Field id="title" label="Judul">
        {(a11y) => <input id="title" name="title" {...a11y} />}
      </Field>,
    );
    const input = screen.getByLabelText("Judul");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("FormError", () => {
  it("announces a form-level message as an alert and renders nothing without one", () => {
    const { rerender } = render(<FormError message={undefined} />);
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(<FormError message="Terjadi kesalahan. Coba lagi." />);
    expect(screen.getByRole("alert").textContent).toBe("Terjadi kesalahan. Coba lagi.");
  });
});
