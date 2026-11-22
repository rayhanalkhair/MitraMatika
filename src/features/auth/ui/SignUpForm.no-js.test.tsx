// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { IntlWrapper } from "@/test/intl";
import type { SignUpState } from "../schema/auth-forms";

// Sign-up works without JavaScript: the browser posts the form to the Server Action and React
// renders the page again with the action's state in `useActionState`. That server render is
// simulated here: `useActionState` answers with the state of a refused post, and its dispatch
// carries the marker a Server Action reference gives React for the form's `action` attribute.
const noJs = vi.hoisted(() => ({
  state: undefined as SignUpState | undefined,
  dispatch: Object.assign(() => undefined, {
    $$FORM_ACTION: () => ({
      name: "$ACTION_ID_sign-up",
      action: "/sign-up",
      encType: "multipart/form-data",
      method: "POST",
      data: null,
    }),
  }),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useActionState: (...args: Parameters<typeof actual.useActionState>) =>
      noJs.state === undefined
        ? actual.useActionState(...args)
        : [noJs.state, noJs.dispatch, false],
  };
});
vi.mock("@/features/auth/actions/sign-up", () => ({ signUpAction: vi.fn() }));

import { SignUpForm } from "./SignUpForm";

function renderPostWithoutJs(state: SignUpState) {
  noJs.state = state;
  const container = document.createElement("div");
  container.innerHTML = renderToString(
    <IntlWrapper>
      <SignUpForm />
    </IntlWrapper>,
  );
  noJs.state = undefined;
  return container;
}

describe("SignUpForm without JavaScript", () => {
  it("posts to the Server Action and renders its errors and the typed values on the first render", () => {
    const html = renderPostWithoutJs({
      fieldErrors: { email: "emailInvalid" },
      values: {
        name: "Bu Rina",
        email: "rina@",
        schoolName: "SMP 1",
        acceptPrivacy: "on",
      },
    });
    const form = html.querySelector("form");
    const input = (id: string) => html.querySelector<HTMLInputElement>(`#${id}`);

    expect(form?.getAttribute("action")).toBe("/sign-up");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(input("sign-up-name")?.getAttribute("value")).toBe("Bu Rina");
    expect(input("sign-up-email")?.getAttribute("value")).toBe("rina@");
    expect(input("sign-up-school")?.getAttribute("value")).toBe("SMP 1");
    expect(input("sign-up-privacy")?.hasAttribute("checked")).toBe(true);
    // Passwords never come back.
    expect(input("sign-up-password")?.getAttribute("value") ?? "").toBe("");
    expect(input("sign-up-confirm-password")?.getAttribute("value") ?? "").toBe("");

    const email = input("sign-up-email");
    expect(email?.getAttribute("aria-invalid")).toBe("true");
    const errorId = email?.getAttribute("aria-describedby") ?? "";
    expect(html.querySelector(`[id="${errorId}"]`)?.textContent).toBe(
      "Masukkan alamat email yang valid.",
    );
    expect(input("sign-up-name")?.getAttribute("aria-invalid")).toBeNull();
  });

  it("renders a form-level error from the server", () => {
    const html = renderPostWithoutJs({
      error: "rateLimited",
      values: { name: "Bu Rina", email: "rina@example.test", acceptPrivacy: "" },
    });
    expect(html.querySelector("[role='alert']")?.textContent).toBe(
      "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
    );
    expect(
      html.querySelector<HTMLInputElement>("#sign-up-privacy")?.hasAttribute("checked"),
    ).toBe(false);
  });
});
