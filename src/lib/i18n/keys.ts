import type messages from "../../../messages/id.json";

// Message keys are derived from the Indonesian catalog (the source of truth); en.json is held to
// the same key set by the parity test.
export type MessageCatalog = typeof messages;
