import "server-only";
import { getEnv } from "@/lib/env";
import { err, type Result } from "@/lib/result";
import { createResendSender } from "./resend";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (msg: EmailMessage) => Promise<Result<void>>;

export const EMAIL_NOT_CONFIGURED = "email_not_configured";

const notConfigured: SendEmail = () => Promise.resolve(err(EMAIL_NOT_CONFIGURED));

// Email needs both the Resend key and a sender address on a verified domain. Read lazily on every call, so a missing key never breaks an import and a key added to the
// environment takes effect without a restart.
export function getEmailSender(): SendEmail {
  const { RESEND_API_KEY, EMAIL_FROM } = getEnv();
  if (!RESEND_API_KEY || !EMAIL_FROM) return notConfigured;
  return createResendSender({ apiKey: RESEND_API_KEY, from: EMAIL_FROM });
}
