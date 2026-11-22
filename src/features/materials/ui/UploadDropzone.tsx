"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type DragEvent } from "react";
import {
  CAMERA_ACCEPT,
  extensionOf,
  MATERIAL_ACCEPT,
  MATERIAL_TYPES,
  MAX_MATERIAL_BYTES,
  STORAGE_CAP_BYTES,
  type UploadErrorKey,
} from "../schema/upload";
import { StorageMeter } from "./StorageMeter";
import { UploadProgress } from "./UploadProgress";

/** The same name, type and size rules as startUpload, checked before any request. */
function precheck(file: File): UploadErrorKey | null {
  const ext = extensionOf(file.name);
  if (ext === "doc" || file.type === "application/msword") return "doc";
  if (ext === null) return "type";
  if (file.type !== "" && file.type !== MATERIAL_TYPES[ext].mime) return "type";
  if (file.size <= 0 || file.size > MAX_MATERIAL_BYTES) return "size";
  return null;
}

const pickClass =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-border bg-card px-4 font-heading text-sm font-semibold text-primary transition-colors duration-150 hover:bg-accent focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring";

/**
 * Where a teacher adds learning materials: drag and drop or a file picker (PDF, DOCX, JPG, PNG),
 * a camera button for phones, the privacy notice and the storage meter. Each accepted file
 * uploads on its own (UploadProgress).
 */
export function UploadDropzone({
  usedBytes,
  folderId,
}: {
  usedBytes: number;
  folderId?: string;
}) {
  const t = useTranslations("materials.upload");
  const router = useRouter();
  const id = useId();
  const [uploads, setUploads] = useState<{ key: number; file: File }[]>([]);
  const [error, setError] = useState<UploadErrorKey | null>(null);
  const [dragging, setDragging] = useState(false);
  const next = useRef(0);

  function add(files: FileList | null) {
    if (!files) return;
    const accepted: { key: number; file: File }[] = [];
    let refused: UploadErrorKey | null = null;
    for (const file of Array.from(files)) {
      const problem = precheck(file);
      if (problem) {
        refused = problem;
        continue;
      }
      next.current += 1;
      accepted.push({ key: next.current, file });
    }
    setError(refused);
    if (accepted.length > 0) setUploads((current) => [...current, ...accepted]);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    add(event.dataTransfer.files);
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4">
      <h2 id={`${id}-title`} className="font-heading text-lg font-semibold">
        {t("title")}
      </h2>
      <p className="rounded-lg border border-border bg-muted p-3 text-sm">
        {t("privacy")}
      </p>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={drop}
        data-dragging={dragging || undefined}
        className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border p-6 text-center data-dragging:border-primary data-dragging:bg-accent"
      >
        <p className="font-medium">{t("dropLabel")}</p>
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {t("hint")}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <label className={pickClass}>
            {t("chooseFile")}
            <input
              type="file"
              multiple
              accept={MATERIAL_ACCEPT}
              aria-describedby={`${id}-hint`}
              className="sr-only"
              onChange={(event) => {
                add(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <label className={pickClass}>
            {t("takePhoto")}
            <input
              type="file"
              accept={CAMERA_ACCEPT}
              capture="environment"
              className="sr-only"
              onChange={(event) => {
                add(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive-soft p-3 text-sm font-medium text-destructive-foreground"
        >
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <StorageMeter usedBytes={usedBytes} capBytes={STORAGE_CAP_BYTES} />
      {uploads.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {uploads.map(({ key, file }) => (
            <UploadProgress
              key={key}
              file={file}
              folderId={folderId}
              onDismiss={() => {
                setUploads((current) => current.filter((upload) => upload.key !== key));
              }}
              onFinalized={() => {
                // The new material shows in the list (its text is read in the background).
                router.refresh();
              }}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
