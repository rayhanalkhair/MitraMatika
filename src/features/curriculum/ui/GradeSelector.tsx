import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

const GRADES = [7, 8, 9] as const;
// The message key of each grade (the catalog keys are strings).
const GRADE_KEY = { 7: "7", 8: "8", 9: "9" } as const;

// Informational in this phase: only Grade 8 has content. Built as radios so enabling Grades 7
// and 9 (P2-08) only changes `available`.
export function GradeSelector({ selected = 8 }: { selected?: 7 | 8 | 9 }) {
  const t = useTranslations("buatSoal");
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{t("gradeLegend")}</legend>
      <div className="grid grid-cols-3 gap-2">
        {GRADES.map((grade) => {
          const available = grade === 8;
          const id = `grade-${String(grade)}`;
          return (
            <div key={grade}>
              {/* Not named "grade": the form posts the grade from its own hidden field. */}
              <input
                type="radio"
                name="grade-choice"
                id={id}
                value={grade}
                defaultChecked={grade === selected}
                disabled={!available}
                className="peer sr-only"
              />
              <label
                htmlFor={id}
                className={cn(
                  "flex min-h-13 flex-col items-center justify-center gap-0.5 rounded-lg border px-2 text-center text-base transition-colors duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 sm:flex-row sm:gap-2",
                  available
                    ? "cursor-pointer border-border bg-card font-medium text-secondary-foreground peer-checked:border-primary peer-checked:bg-primary peer-checked:font-semibold peer-checked:text-primary-foreground hover:border-primary/40"
                    : "cursor-not-allowed border-border bg-muted text-muted-foreground",
                )}
              >
                {t(`grades.${GRADE_KEY[grade]}`)}
                {!available && (
                  <span className="rounded-full bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground ring-1 ring-border">
                    {t("soon")}
                  </span>
                )}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
