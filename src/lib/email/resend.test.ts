import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructed: [] as string[],
  send: vi.fn(),
}));

// No real network: the SDK client is replaced entirely.
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
    constructor(key: string) {
      mocks.constructed.push(key);
    }
  },
}));

import { createResendSender, RESEND_TIMEOUT_MS } from "./resend";

const MESSAGE = { to: "guru@example.test", subject: "Kode", text: "123456" };

beforeEach(() => {
  mocks.constructed.length = 0;
  mocks.send.mockReset();
});

describe("createResendSender", () => {
  it("sends a plain-text email from the configured address", async () => {
    mocks.send.mockResolvedValue({ data: { id: "e1" }, error: null });
    const send = createResendSender({ apiKey: "re_key", from: "MitraMatika <a@b.co>" });
    await expect(send(MESSAGE)).resolves.toEqual({ ok: true });
    expect(mocks.constructed).toEqual(["re_key"]);
    expect(mocks.send).toHaveBeenCalledWith(
      {
        from: "MitraMatika <a@b.co>",
        to: "guru@example.test",
        subject: "Kode",
        text: "123456",
      },
      expect.anything(),
    );
  });

  it("bounds the call with a 10 s abort signal, below the 30 s route duration", async () => {
    mocks.send.mockResolvedValue({ data: { id: "e1" }, error: null });
    await createResendSender({ apiKey: "re_key", from: "a@b.co" })(MESSAGE);
    const options = mocks.send.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
    expect(RESEND_TIMEOUT_MS).toBe(10_000);
    expect(RESEND_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("reports the Resend error name, never its message", async () => {
    mocks.send.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "secret detail", statusCode: 422 },
    });
    const send = createResendSender({ apiKey: "re_key", from: "a@b.co" });
    await expect(send(MESSAGE)).resolves.toEqual({
      ok: false,
      error: "validation_error",
    });
  });

  it("maps a thrown error to resend_unreachable", async () => {
    mocks.send.mockRejectedValue(new Error("network down"));
    const send = createResendSender({ apiKey: "re_key", from: "a@b.co" });
    await expect(send(MESSAGE)).resolves.toEqual({
      ok: false,
      error: "resend_unreachable",
    });
  });
});
