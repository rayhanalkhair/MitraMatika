import { err, ok } from "@/lib/result";
import type { EmailMessage, SendEmail } from "./index";

export interface FakeEmailSender {
  send: SendEmail;
  messages: EmailMessage[];
}

// Test double: records every message it accepts. With `fail`, it accepts nothing and reports
// that error instead.
export function createFakeEmailSender(options: { fail?: string } = {}): FakeEmailSender {
  const messages: EmailMessage[] = [];
  const send: SendEmail = (msg) => {
    if (options.fail) return Promise.resolve(err(options.fail));
    messages.push(msg);
    return Promise.resolve(ok());
  };
  return { send, messages };
}
