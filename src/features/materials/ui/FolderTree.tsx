"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type SubmitEvent } from "react";
import { Folder, FolderOpen } from "lucide-react";
import { TrashFolderButton } from "@/features/trash/ui/TrashFolderButton";
import { cn } from "@/lib/utils";
import {
  createFolderAction,
  moveFolderAction,
  renameFolderAction,
  type FolderActionState,
} from "../actions/folders";
import { MAX_FOLDER_NAME, type MaterialQuery } from "../schema/library";
import type { FolderItem } from "../service/library";
import { fieldOf } from "./form-field";
import { LiveNotice, type Notice } from "./LiveNotice";
import { materialsHref } from "./materials-href";
import { control, primaryButton, secondaryButton } from "./styles";

const TOP = "";

const linkClass = (current: boolean) =>
  cn(
    "flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    current ? "bg-accent text-primary" : "text-foreground",
  );

/**
 * The folders (one level of subfolders): links that filter the list, and for the folder being
 * viewed, rename, move and move-to-trash (an empty folder only). A form adds a folder at the top
 * level or inside a top-level folder. Outcomes are announced in the live regions.
 */
export function FolderTree({
  folders,
  query,
}: {
  folders: FolderItem[];
  query: MaterialQuery;
}) {
  const t = useTranslations("materials.folders");
  const router = useRouter();
  const id = useId();
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const top = folders.filter((folder) => folder.parentId === null);
  const childrenOf = (parentId: string) =>
    folders.filter((folder) => folder.parentId === parentId);
  const current = folders.find((folder) => folder.id === query.folder) ?? null;

  async function run(
    action: () => Promise<FolderActionState>,
    success: string,
    form?: HTMLFormElement,
  ) {
    setBusy(true);
    setNotice(null);
    let result: FolderActionState;
    try {
      result = await action();
    } catch {
      // The request itself failed (network, a new deploy): nothing was confirmed.
      result = { ok: false, error: "generic" };
    } finally {
      setBusy(false);
    }
    if (!result.ok) {
      setNotice({ kind: "alert", text: t(`errors.${result.error}`) });
      return;
    }
    form?.reset();
    setNotice({ kind: "status", text: success });
    router.refresh();
  }

  function create(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const parent = fieldOf(form, "parentId", TOP);
    void run(
      () =>
        createFolderAction({
          name: fieldOf(form, "name"),
          parentId: parent === TOP ? null : parent,
        }),
      t("create.created"),
      form,
    );
  }

  function rename(event: SubmitEvent<HTMLFormElement>, folderId: string) {
    event.preventDefault();
    const name = fieldOf(event.currentTarget, "name");
    void run(() => renameFolderAction({ folderId, name }), t("current.renamed"));
  }

  function move(event: SubmitEvent<HTMLFormElement>, folderId: string) {
    event.preventDefault();
    const parent = fieldOf(event.currentTarget, "parentId", TOP);
    void run(
      () => moveFolderAction({ folderId, parentId: parent === TOP ? null : parent }),
      t("current.moved"),
    );
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="flex min-w-0 flex-col gap-4">
      <h2 id={`${id}-heading`} className="font-heading text-lg font-semibold">
        {t("heading")}
      </h2>
      <nav aria-label={t("navLabel")}>
        <ul className="flex min-w-0 flex-col gap-1">
          <li>
            <Link
              href={materialsHref(query, { folder: undefined })}
              aria-current={query.folder === undefined ? "page" : undefined}
              className={linkClass(query.folder === undefined)}
            >
              <FolderOpen aria-hidden="true" className="size-4 shrink-0" />
              {t("all")}
            </Link>
          </li>
          {top.map((folder) => (
            <li key={folder.id} className="flex min-w-0 flex-col gap-1">
              <FolderLink folder={folder} query={query} />
              {childrenOf(folder.id).length > 0 && (
                <ul className="flex min-w-0 flex-col gap-1 ps-6">
                  {childrenOf(folder.id).map((child) => (
                    <li key={child.id}>
                      <FolderLink folder={child} query={query} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {folders.length === 0 && (
          <p className="px-3 text-sm text-muted-foreground">{t("empty")}</p>
        )}
      </nav>

      <LiveNotice notice={notice} />

      {current && (
        <section
          aria-labelledby={`${id}-current`}
          className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 shadow-card"
        >
          <h3 id={`${id}-current`} className="font-heading font-semibold break-words">
            {t("current.heading")}: {current.name}
          </h3>
          <form
            key={`rename-${current.id}`}
            onSubmit={(event) => {
              rename(event, current.id);
            }}
            className="flex min-w-0 flex-col gap-2"
          >
            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
              {t("current.name")}
              <input
                name="name"
                required
                maxLength={MAX_FOLDER_NAME}
                defaultValue={current.name}
                className={control}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className={`${secondaryButton} self-start`}
            >
              {t("current.rename")}
            </button>
          </form>
          <form
            key={`move-${current.id}`}
            onSubmit={(event) => {
              move(event, current.id);
            }}
            className="flex min-w-0 flex-col gap-2"
          >
            <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
              {t("current.move")}
              <select
                name="parentId"
                defaultValue={current.parentId ?? TOP}
                className={control}
              >
                <option value={TOP}>{t("create.topLevel")}</option>
                {top
                  .filter((folder) => folder.id !== current.id)
                  .map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {t("create.inside", { name: folder.name })}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={busy}
              className={`${secondaryButton} self-start`}
            >
              {t("current.moveSubmit")}
            </button>
          </form>
          <TrashFolderButton folderId={current.id} name={current.name} />
        </section>
      )}

      <form onSubmit={create} className="flex min-w-0 flex-col gap-2">
        <h3 className="font-heading font-semibold">{t("create.heading")}</h3>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {t("create.name")}
          <input name="name" required maxLength={MAX_FOLDER_NAME} className={control} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm font-medium">
          {t("create.parent")}
          <select
            name="parentId"
            defaultValue={current?.parentId ?? current?.id ?? TOP}
            className={control}
          >
            <option value={TOP}>{t("create.topLevel")}</option>
            {top.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {t("create.inside", { name: folder.name })}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy} className={`${primaryButton} self-start`}>
          {t("create.submit")}
        </button>
      </form>
    </section>
  );
}

function FolderLink({ folder, query }: { folder: FolderItem; query: MaterialQuery }) {
  const t = useTranslations("materials.folders");
  const current = query.folder === folder.id;
  return (
    <Link
      href={materialsHref(query, { folder: folder.id })}
      aria-current={current ? "page" : undefined}
      className={linkClass(current)}
    >
      <Folder aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{folder.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("count", { count: folder.materialCount })}
      </span>
    </Link>
  );
}
