import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { getApprovalState, isUuid } from "@/features/assessments";
import { requireAllowedUser } from "@/features/auth";
import {
  buildDocumentModel,
  loadExportSnapshot,
  renderDocument,
  type DocumentKind,
  type WarningWhere,
} from "@/features/export";
import { getTemplate, readLogo } from "@/features/templates";
import { runAsUser } from "@/lib/db/client";
import { safeErrorSummary } from "@/lib/db/error-summary";
import { getDb } from "@/lib/db/runtime";
import { logger } from "@/lib/logger";
import { getObjectStore } from "@/lib/storage";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("assessments");
  return { title: t("editor.preview") };
}

const KINDS = ["paper", "key", "solutions"] as const satisfies readonly DocumentKind[];
const parseKind = (value: string | string[] | undefined): DocumentKind =>
  KINDS.find((kind) => kind === value) ?? "paper";

interface Logo {
  bytes: Uint8Array;
  contentType: string;
}

type Translate = Awaited<ReturnType<typeof getTranslations<"assessments.preview">>>;

function whereLabel(nav: Translate, where: WarningWhere): string {
  switch (where.part) {
    case "stem":
      return nav("where.stem", { number: where.number ?? 0 });
    case "option":
      return nav("where.option", { number: where.number, label: where.label });
    case "step":
      return nav("where.step", { number: where.number, step: where.step });
    case "sectionInstructions":
      return nav("where.sectionInstructions", { section: where.section });
    case "instructions":
      return nav("where.instructions");
  }
}

export default async function AssessmentPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAllowedUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const kind = parseKind((await searchParams).kind);
  const ownerId = user.userId;

  // One transaction under RLS as the signed-in teacher; every read also names the owner.
  const loaded = await runAsUser(getDb(), ownerId, async (tx) => {
    const result = await loadExportSnapshot(tx, {
      ownerId,
      assessmentId: id,
    });
    if (!result.ok) return result;
    const snapshot = result.data;
    const found = snapshot.template
      ? await getTemplate(tx, {
          ownerId,
          templateId: snapshot.template.id,
        })
      : null;
    const approval = await getApprovalState(tx, {
      ownerId,
      assessmentId: id,
    });
    return {
      ok: true as const,
      snapshot,
      template: found?.ok ? found.data : null,
      approval,
    };
  });
  if (!loaded.ok && loaded.error === "notFound") notFound();
  if (!loaded.ok) {
    // A pinned question version is gone (only a draft can lose one, R11): say so, do not 404.
    const missing = await getTranslations("assessments");
    return (
      <PageContainer>
        <PageHeader
          title={missing("editor.preview")}
          actions={
            <Link
              href={`/assessment-builder/${id}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-primary underline-offset-4 hover:underline"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              {missing("preview.back")}
            </Link>
          }
        />
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm font-medium text-destructive-foreground"
        >
          {missing("preview.missingVersion")}
        </p>
      </PageContainer>
    );
  }
  const { snapshot, template, approval } = loaded;
  // The assessment names a template that cannot be read (trashed): the preview falls back to the
  // defaults, and says so.
  const templateMissing = snapshot.template !== null && template === null;

  // The logo is read after the transaction (readLogo runs its own owner-checked one). A logo that
  // cannot be read leaves the letterhead without it; it never fails the preview.
  let logo: Logo | null = null;
  if (template?.hasLogo) {
    try {
      const result = await readLogo(getObjectStore(), getDb(), {
        ownerId,
        templateId: template.id,
      });
      if (result.ok) logo = result.data;
    } catch (error) {
      logger.warn(
        { module: "export", err: safeErrorSummary(error) },
        "export: could not read the template logo for the preview",
      );
    }
  }

  const doc = buildDocumentModel(snapshot, template, { logo });
  const { html, warnings } = renderDocument(doc, kind, doc.page);
  const failed = warnings.filter((warning) => warning.code === "mathFailed");
  const tooWide = warnings.filter((warning) => warning.code === "mathTooWide");
  const t = await getTranslations("assessments");
  const nav = await getTranslations("assessments.preview");

  return (
    <PageContainer>
      <PageHeader
        title={snapshot.title}
        eyebrow={t("editor.preview")}
        description={nav("description")}
        actions={
          <Link
            href={`/assessment-builder/${id}`}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-semibold text-primary underline-offset-4 hover:underline"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {nav("back")}
          </Link>
        }
      />
      <div className="flex min-w-0 flex-col gap-4">
        <nav aria-label={nav("kindNav")} className="flex flex-wrap gap-2">
          {KINDS.map((value) => (
            <Link
              key={value}
              href={`/assessment-builder/${id}/preview?kind=${value}`}
              aria-current={value === kind ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-semibold transition-colors duration-150",
                value === kind
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card text-foreground hover:bg-accent",
              )}
            >
              {nav(`kinds.${value}`)}
            </Link>
          ))}
        </nav>
        {templateMissing && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm font-medium text-destructive-foreground"
          >
            {nav("templateMissing")}
          </p>
        )}
        {!approval?.approved && (
          <p className="text-sm text-muted-foreground">{nav("draftNote")}</p>
        )}
        {failed.length > 0 && (
          <div
            role="status"
            className="rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm text-destructive-foreground"
          >
            <p className="font-semibold">{nav("warningsHeading")}</p>
            <p>{nav("warningsHint")}</p>
            <ul className="mt-2 list-disc pl-5">
              {failed.map((warning, index) => (
                <li key={index}>{whereLabel(nav, warning.where)}</li>
              ))}
            </ul>
          </div>
        )}
        {tooWide.length > 0 && (
          <div
            role="status"
            className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-foreground"
          >
            <p className="font-semibold">{nav("tooWideHeading")}</p>
            <p>{nav("tooWideHint")}</p>
            <ul className="mt-2 list-disc pl-5">
              {tooWide.map((warning, index) => (
                <li key={index}>{whereLabel(nav, warning.where)}</li>
              ))}
            </ul>
          </div>
        )}
        {/*
          The document is user content, so it is shown in an iframe with an empty sandbox: no
          scripts, no same-origin access, no forms, no navigation. The HTML is also escaped at
          build time and carries its own CSP; this is the second layer.
        */}
        <iframe
          title={`${nav("frameTitle")}: ${nav(`kinds.${kind}`)}`}
          sandbox=""
          srcDoc={html}
          className="h-[80vh] min-h-96 w-full rounded-lg border bg-card"
        />
        <p className="text-xs text-muted-foreground">{nav("paperInfo")}</p>
        <p className="text-xs text-muted-foreground">{nav("pdfNote")}</p>
      </div>
    </PageContainer>
  );
}
