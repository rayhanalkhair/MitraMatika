import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import id from "../../messages/id.json";
import type { StartUploadError } from "@/features/materials";
import type { StartPhotoError } from "@/features/solver";
import type { LogoErrorKey } from "@/features/templates";

// Every refusal a storage writer can answer must have a message in both languages. A `satisfies
// Record<Union, true>` object lists the codes, so adding a code to a union without adding it
// here (and its copy) is a compile error, and a missing message fails the test.
const START_UPLOAD = {
  type: true,
  doc: true,
  size: true,
  quota: true,
  pending: true,
  appFull: true,
  storageBusy: true,
} satisfies Record<StartUploadError, true>;

const START_PHOTO = {
  limit: true,
  visionLimit: true,
  pending: true,
  appFull: true,
  quota: true,
  storageBusy: true,
} satisfies Record<StartPhotoError, true>;

const LOGO = {
  empty: true,
  tooLarge: true,
  unsupportedType: true,
  svgNotAccepted: true,
  invalidImage: true,
  dimensionsTooLarge: true,
  appFull: true,
  storageBusy: true,
  quota: true,
  notFound: true,
  unauthenticated: true,
  generic: true,
} satisfies Record<LogoErrorKey, true>;

type Messages = typeof en;

const groups: {
  name: string;
  codes: string[];
  pick: (messages: Messages) => Record<string, unknown>;
}[] = [
  {
    name: "materials.upload.errors (start an upload)",
    codes: Object.keys(START_UPLOAD),
    pick: (m) => m.materials.upload.errors,
  },
  {
    name: "solve.errors (start a photo)",
    codes: Object.keys(START_PHOTO),
    pick: (m) => m.solve.errors,
  },
  {
    name: "settings.templates.logo.errors",
    codes: Object.keys(LOGO),
    pick: (m) => m.settings.templates.logo.errors,
  },
];

describe("storage writer errors have copy in both languages", () => {
  for (const group of groups) {
    for (const [locale, messages] of [
      ["en", en],
      ["id", id],
    ] as const) {
      it(`${group.name} in ${locale}`, () => {
        const copy = group.pick(messages);
        const missing = group.codes.filter(
          (code) => typeof copy[code] !== "string" || copy[code] === "",
        );
        expect(missing).toEqual([]);
      });
    }
  }

  it("says storageBusy differently from appFull, so a teacher knows to retry", () => {
    for (const messages of [en, id]) {
      const { errors } = messages.materials.upload;
      expect(errors.storageBusy).not.toBe(errors.appFull);
    }
  });
});
