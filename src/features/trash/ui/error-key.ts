import { useLocale, useTranslations } from "next-intl";
import type { TrashActionResult } from "../actions/action-support";

export type TrashEntity =
  "question" | "assessment" | "template" | "material" | "folder" | "solver_session";
type Refused = Extract<TrashActionResult, { ok: false }>;

const GONE = {
  question: { not_found: "errors.notFound", not_in_trash: "errors.notInTrash" },
  assessment: {
    not_found: "errors.assessmentGone",
    not_in_trash: "errors.assessmentGone",
  },
  template: { not_found: "errors.templateGone", not_in_trash: "errors.templateGone" },
  material: { not_found: "errors.materialGone", not_in_trash: "errors.materialGone" },
  folder: { not_found: "errors.folderGone", not_in_trash: "errors.folderGone" },
  solver_session: {
    not_found: "errors.solverSessionGone",
    not_in_trash: "errors.solverSessionGone",
  },
} as const;

// Only a question or a template can be refused for being in use; an assessment never is, so it
// has no message of its own and falls back to the generic one.
const IN_USE: Partial<
  Record<TrashEntity, "errors.questionInUse" | "errors.templateInUse">
> = {
  question: "errors.questionInUse",
  template: "errors.templateInUse",
};

/** The `trash.errors.*` message of a refused trash action on this kind of row. */
export function useTrashErrorText(): (result: Refused, entity: TrashEntity) => string {
  const t = useTranslations("trash");
  const locale = useLocale();
  return (result, entity) => {
    switch (result.reason) {
      case "signed_out":
        return t("errors.signedOut");
      case "generic":
        return t("errors.generic");
      // Only a folder is refused for still holding something.
      case "not_empty":
        return entity === "folder" ? t("errors.folderNotEmpty") : t("errors.generic");
      case "in_use": {
        const key = IN_USE[entity];
        if (key === undefined) return t("errors.generic");
        return t(key, {
          assessments: new Intl.ListFormat(locale, {
            style: "long",
            type: "conjunction",
          }).format(result.assessments.map((title) => `“${title}”`)),
        });
      }
      default:
        return t(GONE[entity][result.reason]);
    }
  };
}
