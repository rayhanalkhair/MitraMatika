import { useTranslations } from "next-intl";
import { USER_DAILY_VISION_READS } from "@/features/materials/ui/vision-cap";
import { MAX_METHODS, MAX_PROBLEM_CHARS, USER_DAILY_SOLVES } from "../schema/solver";

/** The `solve.errors.*` message of a refused solver action (unknown codes are generic). */
export function useSolverErrorText(): (error: string) => string {
  const t = useTranslations("solve.errors");
  return (error) => {
    switch (error) {
      case "tooLong":
        return t("tooLong", { max: MAX_PROBLEM_CHARS });
      case "limit":
        return t("limit", { limit: USER_DAILY_SOLVES });
      case "visionLimit":
        return t("visionLimit", { limit: USER_DAILY_VISION_READS });
      case "noMore":
        return t("noMore", { max: MAX_METHODS });
      case "empty":
      case "pending":
      case "appFull":
      case "type":
      case "size":
      case "image":
      case "missing":
      case "expired":
      case "upload":
      case "notFound":
      case "state":
      case "markers":
      case "busy":
      case "unauthenticated":
        return t(error);
      default:
        return t("generic");
    }
  };
}
