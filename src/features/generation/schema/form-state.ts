import type { MessageCatalog } from "@/lib/i18n/keys";

export type GenerationFieldName = "grade" | "topic" | "count" | "difficulty" | "material";
// A key into `generate.errors` in the message catalogs; the form translates it for the active locale.
export type GenerationErrorKey = keyof MessageCatalog["generate"]["errors"];
export type GenerationFieldErrors = Partial<
  Record<GenerationFieldName, GenerationErrorKey>
>;

export interface GenerationFormState {
  fieldErrors?: GenerationFieldErrors;
  error?: "generic" | "unauthenticated";
  activeRequestId?: string;
  // `resetsAt` is an ISO string: the state crosses the server action boundary and the form formats it
  // in the viewer's time zone.
  dailyLimit?: { limit: number; used: number; remaining: number; resetsAt: string };
}

export const initialGenerationState: GenerationFormState = {};
