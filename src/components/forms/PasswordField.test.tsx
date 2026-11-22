// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";
import { PasswordField } from "./PasswordField";

afterEach(cleanup);

describe("PasswordField", () => {
  it("is a labelled password input with the given autocomplete", () => {
    renderWithIntl(
      <PasswordField
        id="pw"
        name="password"
        label="Kata sandi"
        autoComplete="new-password"
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Kata sandi");
    expect(input.type).toBe("password");
    expect(input.name).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
  });

  it("shows and hides the password with a toggle button that reports aria-pressed", async () => {
    renderWithIntl(
      <PasswordField
        id="pw"
        name="password"
        label="Kata sandi"
        autoComplete="current-password"
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Kata sandi");
    const toggle = screen.getByRole("button", { name: "Tampilkan kata sandi" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("pw");
    expect(toggle.getAttribute("type")).toBe("button");

    await userEvent.click(toggle);
    expect(input.type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(toggle);
    expect(input.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("links the hint and the error with aria-describedby and marks the input invalid", () => {
    renderWithIntl(
      <PasswordField
        id="pw"
        name="password"
        label="Kata sandi"
        autoComplete="new-password"
        hint="8 sampai 128 karakter."
        error="Kata sandi minimal 8 karakter."
      />,
    );
    const input = screen.getByLabelText("Kata sandi");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    const texts = ids.map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(["Kata sandi minimal 8 karakter.", "8 sampai 128 karakter."]);
  });

  it("PasswordField toggles visibility without losing the typed value, aria-pressed follows", async () => {
    let attached: HTMLInputElement | null = null;
    renderWithIntl(
      <PasswordField
        id="pw"
        label="Kata sandi"
        autoComplete="new-password"
        registration={{
          name: "password",
          onChange: () => Promise.resolve(),
          onBlur: () => Promise.resolve(),
          ref: (element: HTMLInputElement | null) => {
            attached = element;
          },
        }}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Kata sandi");
    expect(input.name).toBe("password");
    expect(attached).toBe(input);
    await userEvent.type(input, "rahasia123");
    const toggle = screen.getByRole("button", { name: "Tampilkan kata sandi" });

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(input.type).toBe("text");
    expect(input.value).toBe("rahasia123");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(input.type).toBe("password");
    expect(input.value).toBe("rahasia123");
  });

  it("is not marked invalid without an error", () => {
    renderWithIntl(
      <PasswordField
        id="pw"
        name="password"
        label="Kata sandi"
        autoComplete="new-password"
      />,
    );
    const input = screen.getByLabelText("Kata sandi");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });
});
