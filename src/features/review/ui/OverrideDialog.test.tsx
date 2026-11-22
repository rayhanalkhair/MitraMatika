// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/intl";
import { OverrideDialog } from "./OverrideDialog";

afterEach(cleanup);

function Harness({ onConfirm }: { onConfirm: (note: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
        }}
      >
        buka
      </button>
      <OverrideDialog open={open} onOpenChange={setOpen} onConfirm={onConfirm} />
    </>
  );
}

const submit = () => screen.getByRole("button", { name: "Setujui soal ini" });
const note = () => screen.getByRole("textbox", { name: /Catatan pemeriksaan Anda/ });
const tick = () =>
  screen.getByRole("checkbox", { name: "Saya sudah memeriksa; kunci jawaban benar" });

describe("OverrideDialog", () => {
  it("shows the title, the intro, the hint and a 500 character limit", () => {
    renderWithIntl(<Harness onConfirm={vi.fn()} />);
    expect(screen.getByText("Setujui soal yang ditemukan tidak sesuai")).toBeTruthy();
    expect(screen.getByText(/Setujui hanya jika Anda sudah memeriksanya/)).toBeTruthy();
    expect(screen.getByText(/10–500 karakter/)).toBeTruthy();
    expect(note().getAttribute("maxlength")).toBe("500");
  });

  it("keeps the submit button disabled until both the tick and a 10 character note exist", () => {
    renderWithIntl(<Harness onConfirm={vi.fn()} />);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tick());
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(note(), { target: { value: "123456789" } });
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(note(), { target: { value: "1234567890" } });
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(tick());
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not count surrounding whitespace toward the 10 characters", () => {
    renderWithIntl(<Harness onConfirm={vi.fn()} />);
    fireEvent.click(tick());
    fireEvent.change(note(), { target: { value: "   123456789   " } });
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms with the trimmed note and closes", () => {
    const onConfirm = vi.fn();
    renderWithIntl(<Harness onConfirm={onConfirm} />);
    fireEvent.click(tick());
    fireEvent.change(note(), { target: { value: "  Sudah dihitung ulang.  " } });
    fireEvent.click(submit());
    expect(onConfirm).toHaveBeenCalledWith("Sudah dihitung ulang.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears the fields on cancel", () => {
    const onConfirm = vi.fn();
    renderWithIntl(<Harness onConfirm={onConfirm} />);
    fireEvent.click(tick());
    fireEvent.change(note(), { target: { value: "Catatan yang panjang." } });
    fireEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "buka" }));
    expect((note() as HTMLTextAreaElement).value).toBe("");
    expect((tick() as HTMLInputElement).checked).toBe(false);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it("treats the note as plain text", () => {
    renderWithIntl(<Harness onConfirm={vi.fn()} />);
    fireEvent.change(note(), { target: { value: "<b>x</b> catatan saya" } });
    expect((note() as HTMLTextAreaElement).value).toBe("<b>x</b> catatan saya");
    expect(document.body.querySelector("b")).toBeNull();
  });

  it("keeps the 44 px controls", () => {
    renderWithIntl(<Harness onConfirm={vi.fn()} />);
    expect(submit().className).toMatch(/min-h-11/);
    expect(screen.getByRole("button", { name: "Batal" }).className).toMatch(/min-h-11/);
  });

  it("links the hint to the textarea with aria-describedby", () => {
    renderWithIntl(<Harness onConfirm={vi.fn()} />);
    const id = note().getAttribute("aria-describedby")!;
    expect(document.getElementById(id)?.textContent).toMatch(/10\u2013500 karakter/);
  });
});
