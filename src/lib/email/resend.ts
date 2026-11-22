import "server-only";
import { Resend, type CreateEmailRequestOptions } from "resend";
import { err, ok } from "@/lib/result";
import type { SendEmail } from "./index";

// The sign-in code is sent after the response (after()), which lives only as long as the route's
// maxDuration (30 s on /api/auth and /sign-in). A hung Resend call must give up well before that.
export const RESEND_TIMEOUT_MS = 10_000;

// Plain-text email through Resend. Only the Resend error name is reported: its message can echo
// request details, and callers log what they get back.
export function createResendSender(config: { apiKey: string; from: string }): SendEmail {
  const client = new Resend(config.apiKey);
  return async ({ to, subject, text }) => {
    try {
      // The SDK spreads its request options into fetch(), so `signal` takes effect even though
      // its types do not list it. An aborted call comes back as an `application_error`.
      const options = {
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      } as CreateEmailRequestOptions;
      const { error } = await client.emails.send(
        {
          from: config.from,
          to,
          subject,
          text,
        },
        options,
      );
      if (error) return err(error.name);
      return ok();
    } catch {
      return err("resend_unreachable");
    }
  };
}
