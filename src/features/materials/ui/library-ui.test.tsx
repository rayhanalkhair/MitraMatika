// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  moveFolder: vi.fn(),
  moveMaterial: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../actions/folders", () => ({
  createFolderAction: mocks.createFolder,
  renameFolderAction: mocks.renameFolder,
  moveFolderAction: mocks.moveFolder,
}));
vi.mock("../actions/move-material", () => ({ moveMaterialAction: mocks.moveMaterial }));
vi.mock("@/features/trash/ui/TrashFolderButton", () => ({
  TrashFolderButton: ({ name }: { name: string }) => (
    <button type="button">{`Pindahkan ke Sampah: ${name}`}</button>
  ),
}));
vi.mock("@/features/trash/ui/TrashMaterialButton", () => ({
  TrashMaterialButton: ({ title }: { title: string }) => (
    <button type="button">{`Pindahkan ke Sampah: ${title}`}</button>
  ),
}));

import type { MaterialQuery } from "../schema/library";
import type { FolderItem, MaterialListItem } from "../service/library";
import { FolderTree } from "./FolderTree";
import { MaterialDetail } from "./MaterialDetail";
import { MaterialList } from "./MaterialList";
import { StorageMeter } from "./StorageMeter";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const ID = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const FOLDERS: FolderItem[] = [
  { id: CHILD, name: "Bab 1", parentId: PARENT, materialCount: 2 },
  { id: PARENT, name: "Kelas 8", parentId: null, materialCount: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("StorageMeter", () => {
  it("shows used of 1 GB as text and as a labelled meter", () => {
    renderWithIntl(<StorageMeter usedBytes={300 * MB} capBytes={GB} />);
    expect(screen.getByText("300 MB dari 1 GB terpakai")).toBeTruthy();
    const meter = screen.getByRole("meter", { name: "Penyimpanan" });
    expect(meter.getAttribute("aria-valuenow")).toBe(String(300 * MB));
    expect(meter.getAttribute("aria-valuemax")).toBe(String(GB));
    expect(meter.getAttribute("aria-valuetext")).toBe("300 MB dari 1 GB terpakai");
    expect(screen.queryByText(/hampir penuh/)).toBeNull();
  });

  it("warns in words when nearly full", () => {
    renderWithIntl(<StorageMeter usedBytes={0.95 * GB} capBytes={GB} />);
    expect(screen.getByText(/Penyimpanan hampir penuh/)).toBeTruthy();
  });
});

describe("MaterialList", () => {
  const item: MaterialListItem = {
    id: ID,
    title: "Buku Siswa Kelas 8",
    kind: "pdf",
    status: "needs_review",
    grade: 8,
    academicYear: "2026/2027",
    pageCount: 184,
    sizeBytes: 1000,
    folderId: PARENT,
    folderName: "Kelas 8",
    structureConfirmed: true,
    createdAt: "2026-11-20T01:00:00.000Z",
    matchPage: 12,
  };
  const query: MaterialQuery = { page: 1 };

  it("shows each material with a link, its status in words and its facts", () => {
    renderWithIntl(<MaterialList items={[item]} libraryTotal={1} query={query} />);
    const [row] = within(
      screen.getByRole("list", { name: "Daftar materi" }),
    ).getAllByRole("listitem");
    expect(
      within(row).getByRole("link", { name: "Buku Siswa Kelas 8" }).getAttribute("href"),
    ).toBe(`/materials/${ID}`);
    for (const text of [
      "Perlu ditinjau",
      "Kelas 8",
      "2026/2027",
      "184 halaman",
      "Folder: Kelas 8",
      "Struktur dikonfirmasi",
      "Ditemukan di hal. 12",
    ]) {
      expect(row.textContent).toContain(text);
    }
  });

  it("tells an empty library from a search with no match", () => {
    renderWithIntl(<MaterialList items={[]} libraryTotal={0} query={query} />);
    expect(screen.getByText("Belum ada materi.")).toBeTruthy();
    cleanup();
    renderWithIntl(
      <MaterialList items={[]} libraryTotal={4} query={{ page: 1, q: "x" }} />,
    );
    expect(screen.getByText("Tidak ada materi yang cocok.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Hapus filter" }).getAttribute("href")).toBe(
      "/materials",
    );
  });
});

describe("FolderTree", () => {
  it("links every folder (one level of subfolders) and marks the current one", () => {
    renderWithIntl(
      <FolderTree folders={FOLDERS} query={{ page: 1, folder: CHILD, q: "a" }} />,
    );
    const nav = screen.getByRole("navigation", { name: "Folder materi" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Semua materi",
      "Kelas 81 materi",
      "Bab 12 materi",
    ]);
    expect(links[2].getAttribute("aria-current")).toBe("page");
    expect(links[2].getAttribute("href")).toBe(`/materials?folder=${CHILD}&q=a`);
    expect(links[0].getAttribute("href")).toBe("/materials?q=a");
    expect(
      screen.getByRole("button", { name: "Pindahkan ke Sampah: Bab 1" }),
    ).toBeTruthy();
  });

  it("creates a folder and announces it; a refusal is an alert", async () => {
    mocks.createFolder.mockResolvedValue({ ok: true, id: "x" });
    renderWithIntl(<FolderTree folders={FOLDERS} query={{ page: 1 }} />);
    await userEvent.type(screen.getByLabelText("Nama folder"), "Semester 2");
    await userEvent.selectOptions(screen.getByLabelText("Letak folder"), PARENT);
    await userEvent.click(screen.getByRole("button", { name: "Buat folder" }));
    expect(mocks.createFolder).toHaveBeenCalledWith({
      name: "Semester 2",
      parentId: PARENT,
    });
    expect(screen.getByRole("status").textContent).toBe("Folder dibuat.");
    expect(mocks.refresh).toHaveBeenCalled();

    mocks.createFolder.mockResolvedValue({ ok: false, error: "nesting" });
    await userEvent.type(screen.getByLabelText("Nama folder"), "Lagi");
    await userEvent.click(screen.getByRole("button", { name: "Buat folder" }));
    expect(screen.getByRole("alert").textContent).toMatch(/bersarang satu tingkat/);
  });

  it("renames and moves the folder being viewed", async () => {
    mocks.renameFolder.mockResolvedValue({ ok: true });
    mocks.moveFolder.mockResolvedValue({ ok: false, error: "retry" });
    renderWithIntl(<FolderTree folders={FOLDERS} query={{ page: 1, folder: CHILD }} />);
    const name = screen.getByLabelText("Nama baru");
    await userEvent.clear(name);
    await userEvent.type(name, "Bab Satu");
    await userEvent.click(screen.getByRole("button", { name: "Ganti nama" }));
    expect(mocks.renameFolder).toHaveBeenCalledWith({
      folderId: CHILD,
      name: "Bab Satu",
    });
    await userEvent.selectOptions(screen.getByLabelText("Pindahkan ke"), "");
    await userEvent.click(screen.getByRole("button", { name: "Pindahkan folder" }));
    expect(mocks.moveFolder).toHaveBeenCalledWith({ folderId: CHILD, parentId: null });
    expect(screen.getByRole("alert").textContent).toMatch(/Coba lagi/);
  });
});

describe("rejected actions and live regions", () => {
  it("keeps one polite and one assertive region whatever happens", () => {
    renderWithIntl(<FolderTree folders={FOLDERS} query={{ page: 1 }} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("re-enables the buttons and says something went wrong when an action rejects", async () => {
    mocks.createFolder.mockRejectedValue(new Error("network"));
    renderWithIntl(<FolderTree folders={FOLDERS} query={{ page: 1 }} />);
    await userEvent.type(screen.getByLabelText("Nama folder"), "Semester 2");
    await userEvent.click(screen.getByRole("button", { name: "Buat folder" }));
    expect(screen.getByRole("alert").textContent).toBe("Terjadi kesalahan. Coba lagi.");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Buat folder" }).disabled,
    ).toBe(false);
    cleanup();

    mocks.moveMaterial.mockRejectedValue(new Error("network"));
    renderWithIntl(
      <MaterialDetail
        detail={{
          id: ID,
          title: "Buku",
          kind: "pdf",
          mime: "application/pdf",
          status: "ready",
          sizeBytes: MB,
          pageCount: 1,
          grade: null,
          academicYear: null,
          folderId: null,
          folderName: null,
          createdAt: "2026-11-20T01:00:00.000Z",
          metadataConfirmedAt: null,
          pages: { total: 1, high: 1, medium: 0, low: 0 },
          flaggedPages: [],
        }}
        folders={FOLDERS}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Pindahkan" }));
    expect(screen.getByRole("alert").textContent).toBe("Terjadi kesalahan. Coba lagi.");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Pindahkan" }).disabled,
    ).toBe(false);
  });
});

describe("MaterialDetail", () => {
  const detail = {
    id: ID,
    title: "Buku Guru",
    kind: "pdf",
    mime: "application/pdf",
    status: "needs_review",
    sizeBytes: 3 * MB,
    pageCount: 3,
    grade: 8,
    academicYear: "2026/2027",
    folderId: null,
    folderName: null,
    createdAt: "2026-11-20T01:00:00.000Z",
    metadataConfirmedAt: null,
    pages: { total: 3, high: 2, medium: 0, low: 1 },
    flaggedPages: [3],
  };

  it("shows the facts and text quality, and moves the material into a folder", async () => {
    mocks.moveMaterial.mockResolvedValue({ ok: true });
    renderWithIntl(<MaterialDetail detail={detail} folders={FOLDERS} />);
    expect(
      screen.getByText("2 halaman jelas, 0 perlu diperiksa, 1 sulit dibaca"),
    ).toBeTruthy();
    expect(screen.getByText("Halaman yang perlu diperiksa: 3")).toBeTruthy();
    expect(screen.getByText("3 MB")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Pindahkan ke folder"), CHILD);
    await userEvent.click(screen.getByRole("button", { name: "Pindahkan" }));
    expect(mocks.moveMaterial).toHaveBeenCalledWith({ materialId: ID, folderId: CHILD });
    expect(screen.getByRole("status").textContent).toBe("Materi dipindahkan.");
  });
});
