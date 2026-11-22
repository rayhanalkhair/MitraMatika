import { describe, expect, it } from "vitest";
import { createFakeEmailSender } from "./fake";

describe("createFakeEmailSender", () => {
  it("records every message it is asked to send", async () => {
    const fake = createFakeEmailSender();
    await expect(fake.send({ to: "a@b.co", subject: "s", text: "t" })).resolves.toEqual({
      ok: true,
    });
    expect(fake.messages).toEqual([{ to: "a@b.co", subject: "s", text: "t" }]);
  });

  it("can fail without recording anything", async () => {
    const fake = createFakeEmailSender({ fail: "boom" });
    await expect(fake.send({ to: "a@b.co", subject: "s", text: "t" })).resolves.toEqual({
      ok: false,
      error: "boom",
    });
    expect(fake.messages).toEqual([]);
  });
});
