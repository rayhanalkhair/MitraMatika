// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { TextField } from "./TextField";

afterEach(cleanup);

describe("TextField", () => {
  it("TextField without registration still renders name and defaultValue", () => {
    render(
      <TextField
        id="sign-in-email"
        name="email"
        type="email"
        label="Email"
        autoComplete="email"
        defaultValue="rina@example.test"
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Email");
    expect(input.name).toBe("email");
    expect(input.value).toBe("rina@example.test");
    expect(input.type).toBe("email");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });

  it("takes its name and handlers from a registration", () => {
    let attached: HTMLInputElement | null = null;
    render(
      <TextField
        id="sample-name"
        label="Nama lengkap"
        autoComplete="name"
        error="Nama harus 2 sampai 80 karakter."
        registration={{
          name: "name",
          onChange: () => Promise.resolve(),
          onBlur: () => Promise.resolve(),
          ref: (element: HTMLInputElement | null) => {
            attached = element;
          },
        }}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Nama lengkap");
    expect(input.name).toBe("name");
    expect(attached).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Nama harus 2 sampai 80 karakter.");
  });

  it("renders a registration's defaultValue in the server render (a post without JavaScript)", () => {
    const html = renderToString(
      <TextField
        id="sample-name"
        label="Nama lengkap"
        autoComplete="name"
        defaultValue="Bu Rina"
        registration={{
          name: "name",
          onChange: () => Promise.resolve(),
          onBlur: () => Promise.resolve(),
          ref: () => undefined,
        }}
      />,
    );
    expect(html).toContain('name="name"');
    expect(html).toContain('value="Bu Rina"');
  });

  it("takes a hint (read after the error) and a maxLength", () => {
    render(
      <TextField
        id="sample-title"
        name="title"
        label="Judul"
        autoComplete="off"
        hint="Dipakai di daftar."
        maxLength={80}
        error="Wajib diisi."
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Judul");
    expect(input.maxLength).toBe(80);
    expect(input.getAttribute("aria-describedby")).toBe(
      "sample-title-error sample-title-hint",
    );
    expect(document.getElementById("sample-title-hint")?.textContent).toBe(
      "Dipakai di daftar.",
    );
  });
});
