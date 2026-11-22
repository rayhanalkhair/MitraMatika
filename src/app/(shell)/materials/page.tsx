import type { Metadata } from "next";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { PageContainer } from "@/components/shell/PageContainer";
import { PageHeader } from "@/components/shell/PageHeader";
import { requireAllowedUser } from "@/features/auth";
import {
  countMaterials,
  listFolders,
  listMaterials,
  MATERIAL_PAGE_SIZE,
  materialQuerySchema,
  storageUsage,
  UploadDropzone,
  type MaterialDb,
} from "@/features/materials";
import { FolderTree } from "@/features/materials/ui/FolderTree";
import { MaterialFilters } from "@/features/materials/ui/MaterialFilters";
import { MaterialList, MaterialPagination } from "@/features/materials/ui/MaterialList";
import { runAsUser } from "@/lib/db/client";
import { getDb } from "@/lib/db/runtime";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("nav.materi") };
}

export default async function MateriPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations();
  const user = await requireAllowedUser();
  // A bad or unknown param falls back to its default; the page never errors on a hand-edited link.
  const query = materialQuerySchema.parse(await searchParams);
  // Under runAsUser so RLS applies on top of the owner filter inside each read model.
  const { list, folders, usage, libraryTotal } = await runAsUser(
    getDb(),
    user.userId,
    async (rawTx) => {
      const tx = rawTx as unknown as MaterialDb;
      const ownerId = user.userId;
      const list = await listMaterials(tx, { ownerId, query });
      const filtered =
        query.folder !== undefined ||
        query.grade !== undefined ||
        query.year !== undefined ||
        query.status !== undefined ||
        query.q !== undefined;
      return {
        list,
        folders: await listFolders(tx, { ownerId }),
        usage: await storageUsage(tx, { ownerId, now: new Date() }),
        libraryTotal: filtered ? await countMaterials(tx, { ownerId }) : list.total,
      };
    },
  );
  // A folder link that no longer leads anywhere (trashed meanwhile) shows every material.
  const folderId = folders.some((folder) => folder.id === query.folder)
    ? query.folder
    : undefined;

  return (
    <PageContainer>
      <PageHeader
        title={t("nav.materi")}
        description={t("materials.library.description")}
        actions={
          <Link
            href="/trash"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-semibold text-foreground transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Trash2 aria-hidden="true" className="size-4" />
            {t("materials.library.openTrash")}
          </Link>
        }
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-6">
          <FolderTree folders={folders} query={query} />
        </aside>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="rounded-lg border bg-card p-4 shadow-card sm:p-6">
            <UploadDropzone usedBytes={usage.usedBytes} folderId={folderId} />
          </div>
          <section
            aria-labelledby="materials-list"
            className="flex min-w-0 flex-col gap-4"
          >
            <h2 id="materials-list" className="font-heading text-lg font-semibold">
              {t("materials.library.listHeading")}
            </h2>
            {libraryTotal > 0 && <MaterialFilters query={query} years={list.years} />}
            <MaterialList items={list.items} libraryTotal={libraryTotal} query={query} />
            <MaterialPagination
              query={query}
              page={list.page}
              pageCount={list.pageCount}
              total={list.total}
              shown={list.items.length}
              pageSize={MATERIAL_PAGE_SIZE}
            />
          </section>
        </div>
      </div>
    </PageContainer>
  );
}
