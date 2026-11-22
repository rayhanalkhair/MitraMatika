// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useTranslations } from "next-intl";
import { renderToString } from "react-dom/server";
import { z } from "zod";
import { FormError } from "@/components/forms/FormError";
import { PasswordField } from "@/components/forms/PasswordField";
import { SubmitButton } from "@/components/forms/SubmitButton";
import { TextField } from "@/components/forms/TextField";
import { IntlWrapper, renderWithIntl } from "@/test/intl";
import type idMessages from "../../../messages/id.json";
import { formDataOf } from "./form-data";
import { useActionForm } from "./use-action-form";

// A three-field sample form, test-only: the layer is proven here before any real form moves.
type ErrorKey = keyof typeof idMessages.auth.fieldErrors;
type SampleField = "name" | "email" | "password";

interface SampleState {
  error?: "rateLimited";
  fieldErrors?: Partial<Record<SampleField, ErrorKey>>;
  values?: { name?: string };
}

const sampleSchema = z.object({
  name: z.string().trim().min(2, "nameLength"),
  email: z.string().trim().pipe(z.email("emailInvalid")),
  password: z.string().min(8, "passwordTooShort"),
});

type Action = (state: SampleState, data: FormData) => Promise<SampleState>;

function SampleForm({
  action,
  initialState = {},
  onSubmitted,
}: {
  action: Action;
  initialState?: SampleState;
  onSubmitted?: () => void;
}) {
  const t = useTranslations("auth");
  const { form, formRef, state, pending, onSubmit } = useActionForm({
    schema: sampleSchema,
    defaultValues: (first) => ({
      name: first.values?.name ?? "",
      email: "",
      password: "",
    }),
    action,
    initialState,
    toPayload: (_values, element) => formDataOf(element),
    fieldErrorsOf: (current) => current.fieldErrors,
    onSubmitted,
  });
  const { errors } = form.formState;
  const fieldError = (field: SampleField) => {
    const key = errors[field]?.message;
    return key ? t(`fieldErrors.${key as ErrorKey}`) : undefined;
  };
  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate>
      <TextField
        id="sample-name"
        label={t("fields.name")}
        autoComplete="name"
        registration={form.register("name")}
        error={fieldError("name")}
      />
      <TextField
        id="sample-email"
        type="email"
        label={t("fields.email")}
        autoComplete="email"
        registration={form.register("email")}
        error={fieldError("email")}
      />
      <PasswordField
        id="sample-password"
        label={t("fields.password")}
        autoComplete="new-password"
        registration={form.register("password")}
        error={fieldError("password")}
      />
      <FormError message={state.error ? t(`formErrors.${state.error}`) : undefined} />
      <SubmitButton
        pending={pending}
        label={t("signUp.submit")}
        pendingLabel={t("working")}
      />
    </form>
  );
}

afterEach(cleanup);

const name = () => screen.getByLabelText<HTMLInputElement>("Nama lengkap");
const email = () => screen.getByLabelText<HTMLInputElement>("Email");
const password = () => screen.getByLabelText<HTMLInputElement>("Kata sandi");
const submit = () => screen.getByRole("button", { name: /Buat akun|Memproses/ });

const describedText = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" | ");

async function fillValid() {
  await userEvent.type(name(), "Bu Rina");
  await userEvent.type(email(), "rina@example.test");
  await userEvent.type(password(), "rahasia123");
}

describe("useActionForm", () => {
  it("shows translated client errors and does not call the action", async () => {
    const action = vi.fn<Action>(() => Promise.resolve({}));
    renderWithIntl(<SampleForm action={action} />);
    await userEvent.type(email(), "bukan-email");
    await userEvent.click(submit());

    await waitFor(() => {
      expect(name().getAttribute("aria-invalid")).toBe("true");
    });
    expect(describedText(name())).toBe("Nama harus 2 sampai 80 karakter.");
    expect(describedText(email())).toBe("Masukkan alamat email yang valid.");
    expect(describedText(password())).toBe("Kata sandi minimal 8 karakter.");
    expect(action).not.toHaveBeenCalled();
  });

  it("submits the form's FormData once valid and tells onSubmitted before the action runs", async () => {
    const calls: string[] = [];
    const action = vi.fn<Action>(() => {
      calls.push("action");
      return Promise.resolve({});
    });
    renderWithIntl(
      <SampleForm
        action={action}
        onSubmitted={() => {
          calls.push("submitted");
        }}
      />,
    );
    await fillValid();
    await userEvent.click(submit());

    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(1);
    });
    expect(calls).toEqual(["submitted", "action"]);
    const data = action.mock.calls[0][1];
    expect(data).toBeInstanceOf(FormData);
    expect(data.get("name")).toBe("Bu Rina");
    expect(data.get("email")).toBe("rina@example.test");
  });

  it("maps server fieldErrors onto the fields with aria-invalid and aria-describedby", async () => {
    const action = vi.fn<Action>(() =>
      Promise.resolve({
        fieldErrors: { email: "emailInvalid", password: "passwordTooShort" },
      }),
    );
    renderWithIntl(<SampleForm action={action} />);
    await fillValid();
    await userEvent.click(submit());

    await waitFor(() => {
      expect(email().getAttribute("aria-invalid")).toBe("true");
    });
    expect(describedText(email())).toBe("Masukkan alamat email yang valid.");
    expect(password().getAttribute("aria-invalid")).toBe("true");
    expect(describedText(password())).toBe("Kata sandi minimal 8 karakter.");
    expect(name().getAttribute("aria-invalid")).toBeNull();
    // The server named email first in DOM order: focus lands there once its error is rendered.
    await waitFor(() => {
      expect(document.activeElement).toBe(email());
    });
  });

  it("keeps typed values after a server error and shows the form error", async () => {
    const action = vi.fn<Action>(() =>
      Promise.resolve({ error: "rateLimited", fieldErrors: { email: "emailInvalid" } }),
    );
    renderWithIntl(<SampleForm action={action} />);
    await fillValid();
    await userEvent.click(submit());

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
    );
    expect(name().value).toBe("Bu Rina");
    expect(email().value).toBe("rina@example.test");
    expect(password().value).toBe("rahasia123");
  });

  it("clears a server error once the teacher fixes the field", async () => {
    const action = vi.fn<Action>(() =>
      Promise.resolve({ fieldErrors: { name: "nameLength" } }),
    );
    renderWithIntl(<SampleForm action={action} />);
    await fillValid();
    await userEvent.click(submit());
    await waitFor(() => {
      expect(name().getAttribute("aria-invalid")).toBe("true");
    });

    await userEvent.type(name(), "!");
    await waitFor(() => {
      expect(name().getAttribute("aria-invalid")).toBeNull();
    });
  });

  it("focuses the first invalid field in DOM order after a failed submit", async () => {
    renderWithIntl(<SampleForm action={vi.fn<Action>()} />);
    await userEvent.type(name(), "Bu Rina");
    await userEvent.click(submit());

    await waitFor(() => {
      expect(document.activeElement).toBe(email());
    });
  });

  it("does not move focus while the user types after a failed submit", async () => {
    renderWithIntl(<SampleForm action={vi.fn<Action>()} />);
    await userEvent.click(submit());
    await waitFor(() => {
      expect(document.activeElement).toBe(name());
    });

    // Fixing the password while name and email are still invalid: live re-validation runs on
    // every key, and focus must stay where the teacher is typing.
    await userEvent.click(password());
    await userEvent.type(password(), "rahasia123");
    await waitFor(() => {
      expect(password().getAttribute("aria-invalid")).toBeNull();
    });
    expect(document.activeElement).toBe(password());
    expect(name().getAttribute("aria-invalid")).toBe("true");
  });

  it("disables the submit button with aria-busy and the pending label while the action runs", async () => {
    let finish: (state: SampleState) => void = () => undefined;
    const action = vi.fn<Action>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderWithIntl(<SampleForm action={action} />);
    await fillValid();
    await userEvent.click(submit());

    await waitFor(() => {
      expect(submit().textContent).toBe("Memproses…");
    });
    expect(submit()).toHaveProperty("disabled", true);
    expect(submit().getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      finish({});
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(submit().textContent).toBe("Buat akun");
    });
    expect(submit()).toHaveProperty("disabled", false);
    expect(submit().getAttribute("aria-busy")).toBe("false");
  });

  it("renders server field errors from the first render, so a post without JavaScript shows them", () => {
    const html = renderToString(
      <IntlWrapper>
        <SampleForm
          action={vi.fn<Action>()}
          initialState={{ fieldErrors: { email: "emailInvalid" } }}
        />
      </IntlWrapper>,
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const input = container.querySelector<HTMLInputElement>("#sample-email");

    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("Masukkan alamat email yang valid.");
  });

  it("takes the default values from the first state, so a refused post keeps them", async () => {
    const action = vi.fn<Action>(() => Promise.resolve({}));
    renderWithIntl(
      <SampleForm action={action} initialState={{ values: { name: "Bu Rina" } }} />,
    );
    await waitFor(() => {
      expect(name().value).toBe("Bu Rina");
    });
    await userEvent.type(email(), "rina@example.test");
    await userEvent.type(password(), "rahasia123");
    await userEvent.click(submit());
    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(1);
    });
    expect(action.mock.calls[0][1].get("name")).toBe("Bu Rina");
  });

  it("clears an error from a post made before JavaScript loaded once the field is edited", async () => {
    renderWithIntl(
      <SampleForm
        action={vi.fn<Action>()}
        initialState={{ fieldErrors: { email: "emailInvalid", name: "nameLength" } }}
      />,
    );
    expect(email().getAttribute("aria-invalid")).toBe("true");

    await userEvent.type(email(), "x");
    await waitFor(() => {
      expect(email().getAttribute("aria-invalid")).toBeNull();
    });
    // Other fields keep theirs until they are edited or the form is submitted.
    expect(name().getAttribute("aria-invalid")).toBe("true");
  });

  it("ignores a second submit while the first is in flight", async () => {
    let finish: (state: SampleState) => void = () => undefined;
    const action = vi.fn<Action>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderWithIntl(<SampleForm action={action} />);
    await fillValid();
    const form = submit().closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(action).toHaveBeenCalledTimes(1);

    // Once the answer is in, the form submits again.
    await act(async () => {
      finish({});
      await Promise.resolve();
    });
    // React runs queued actions one after another: a second dispatch would start now.
    await waitFor(() => {
      expect(submit().textContent).toBe("Buat akun");
    });
    expect(action).toHaveBeenCalledTimes(1);
    fireEvent.submit(form);
    await waitFor(() => {
      expect(action).toHaveBeenCalledTimes(2);
    });
  });
});
