import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { GenerationForm } from "@/features/generation/ui/GenerationForm";
import { GradeSelector } from "@/features/curriculum/ui/GradeSelector";
import { TopicPicker } from "@/features/curriculum/ui/TopicPicker";
import { UnavailableNotice } from "@/features/curriculum/ui/UnavailableNotice";
import { assessmentReturnTo } from "@/lib/navigation/return-to";
import { getCurriculum } from "@/features/curriculum";
import { parsePickerParams } from "@/features/curriculum";
import { logger } from "@/lib/logger";
import { requireAllowedUser } from "@/features/auth";
import { listGenerationMaterials, type GenerationMaterial } from "@/features/generation";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.buatSoal") };
}

// The create-request action triggers the runner after its response, within this page's limit.
export const maxDuration = 300;

type SearchParams = Record<string, string | string[] | undefined>;

async function loadCatalogue() {
  try {
    const curriculum = getCurriculum();
    const [version, topics] = await Promise.all([
      curriculum.getActiveVersion(),
      curriculum.listTopicsWithObjectives(8),
    ]);
    return { ok: true as const, version, topics };
  } catch (error) {
    // Logged server-side only; the teacher sees a generic message.
    logger.error(
      { module: "generation", err: error },
      "generation: could not load the curriculum",
    );
    return { ok: false as const };
  }
}

// The teacher's materials for "Dari materi", read under RLS. A failure only hides the option.
async function loadMaterials(
  userId: string,
): Promise<{ materials: GenerationMaterial[]; truncated: boolean }> {
  try {
    return await runAsUser(getDb(), userId, (tx) => listGenerationMaterials(tx, userId));
  } catch (error) {
    logger.error(
      { module: "generation", err: error instanceof Error ? error.name : "unknown" },
      "generation: could not load the materials",
    );
    return { materials: [], truncated: false };
  }
}

export default async function BuatSoalPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const t = await getTranslations();
  const raw = await searchParams;
  const user = await requireAllowedUser();
  const [catalogue, materials] = await Promise.all([
    loadCatalogue(),
    loadMaterials(user.userId),
  ]);
  const topics = catalogue.ok ? catalogue.topics : [];
  const params = parsePickerParams(raw, topics);
  // Opened from an assessment editor: the way back goes with the request to its status page.
  const returnTo = assessmentReturnTo(raw.returnTo) ?? undefined;
  const comingSoonGrade = params.requestedGrade === 7 || params.requestedGrade === 9;

  const gradeSlot = (
    <>
      <GradeSelector selected={8} />
      {comingSoonGrade && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("buatSoal.gradeComingSoon")}
        </p>
      )}
    </>
  );

  return (
    <PageContainer width="narrow">
      <PageHeader title={t("nav.buatSoal")} description={t("generate.pageDescription")} />
      {!catalogue.ok || !catalogue.version || catalogue.topics.length === 0 ? (
        <div className="flex flex-col gap-4">
          {gradeSlot}
          <UnavailableNotice kind={catalogue.ok ? "empty" : "error"} />
        </div>
      ) : (
        <GenerationForm
          gradeSlot={gradeSlot}
          selectedTopic={params.topicKey}
          returnTo={returnTo}
          materials={materials.materials}
          materialsTruncated={materials.truncated}
        >
          <TopicPicker
            topics={catalogue.topics}
            version={catalogue.version}
            selectedKey={params.topicKey}
          />
        </GenerationForm>
      )}
    </PageContainer>
  );
}
