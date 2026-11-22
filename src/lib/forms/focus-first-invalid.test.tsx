// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { focusFirstInvalid, useFocusFirstInvalid } from "./focus-first-invalid";

afterEach(cleanup);

function Sample({ trigger, invalid }: { trigger: unknown; invalid: string[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, trigger);
  return (
    <form ref={formRef}>
      {["a", "b", "c"].map((name) => (
        <input
          key={name}
          aria-label={name}
          name={name}
          aria-invalid={invalid.includes(name) ? true : undefined}
        />
      ))}
    </form>
  );
}

describe("useFocusFirstInvalid", () => {
  it("focuses the first invalid control in DOM order when the trigger changes", () => {
    const { rerender } = render(<Sample trigger={0} invalid={["c", "b"]} />);
    expect(document.activeElement).toBe(document.body);

    rerender(<Sample trigger={1} invalid={["c", "b"]} />);
    expect(document.activeElement).toBe(screen.getByLabelText("b"));
  });

  it("does nothing for an undefined or zero trigger, or an empty error object", () => {
    const { rerender } = render(<Sample trigger={undefined} invalid={["a"]} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Sample trigger={0} invalid={["a"]} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Sample trigger={{}} invalid={["a"]} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not refocus on a re-render with the same trigger", () => {
    const { rerender } = render(<Sample trigger={1} invalid={["a"]} />);
    expect(document.activeElement).toBe(screen.getByLabelText("a"));
    screen.getByLabelText<HTMLInputElement>("c").focus();

    rerender(<Sample trigger={1} invalid={["a", "b"]} />);
    expect(document.activeElement).toBe(screen.getByLabelText("c"));
  });
});

describe("focusFirstInvalid with a radio group", () => {
  function Group({ checked }: { checked?: string }) {
    return (
      <form data-testid="form">
        <input aria-label="before" />
        <fieldset data-invalid="true">
          <legend>Pilihan</legend>
          {["x", "y"].map((value) => (
            <input
              key={value}
              type="radio"
              name="g"
              value={value}
              aria-label={value}
              defaultChecked={value === checked}
            />
          ))}
        </fieldset>
      </form>
    );
  }

  it("focuses the checked radio of a group marked invalid", () => {
    render(<Group checked="y" />);
    focusFirstInvalid(screen.getByTestId("form"));
    expect(document.activeElement).toBe(screen.getByLabelText("y"));
  });

  it("focuses the first radio when none is checked", () => {
    render(<Group />);
    focusFirstInvalid(screen.getByTestId("form"));
    expect(document.activeElement).toBe(screen.getByLabelText("x"));
  });
});
