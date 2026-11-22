import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { materials } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import { seedMaterial } from "../fixtures/library";
import { makeImage } from "../test-support";
import { handleMaterialFileRequest, type MaterialFileDeps } from "./file-route";

let database: TestDatabase;
let store: MemoryStore;
const PNG = makeImage("png", 10, 10);

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  store = createMemoryStore();
  await database.db.execute(sql`truncate materials, folders restart identity cascade`);
});

const signedIn = (userId: string) => () =>
  Promise.resolve({
    ok: true as const,
    data: {
      status: "allowed" as const,
      userId,
      email: "t@example.test",
      displayName: null,
    },
  });

function deps(userId: string, inline: boolean): MaterialFileDeps {
  return {
    authorize: signedIn(userId),
    db: database.db,
    store: () => store,
    inline: () => inline,
  };
}

async function seedPhoto(ownerId = USER_A) {
  const id = await seedMaterial(database, { ownerId, kind: "image", pageCount: 1 });
  const [row] = await database.db.select().from(materials).where(eq(materials.id, id));
  await store.put(row.objectKey, PNG, "image/png");
  await database.db
    .update(materials)
    .set({ mime: "image/png" })
    .where(eq(materials.id, id));
  return { id, key: row.objectKey };
}

describe("GET /api/materials/[id]/file", () => {
  it("serves the owner's file inline from the development store", async () => {
    const { id } = await seedPhoto();
    const response = await handleMaterialFileRequest(id, deps(USER_A, true));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("redirects to a 5-minute signed URL when files are in R2", async () => {
    const { id, key } = await seedPhoto();
    const response = await handleMaterialFileRequest(id, deps(USER_A, false));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe(`/${key}`);
    expect(location.searchParams.get("expires")).toBe("300");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for another teacher's material, a trashed one and a malformed id", async () => {
    const { id } = await seedPhoto(USER_A);
    expect((await handleMaterialFileRequest(id, deps(USER_B, true))).status).toBe(404);
    expect((await handleMaterialFileRequest(id, deps(USER_B, false))).status).toBe(404);
    expect((await handleMaterialFileRequest("../x", deps(USER_A, true))).status).toBe(
      404,
    );
    await database.db
      .update(materials)
      .set({ deletedAt: new Date() })
      .where(eq(materials.id, id));
    expect((await handleMaterialFileRequest(id, deps(USER_A, true))).status).toBe(404);
  });

  it("answers 401 to a signed-out caller", async () => {
    const { id } = await seedPhoto();
    const response = await handleMaterialFileRequest(id, {
      ...deps(USER_A, true),
      authorize: () => Promise.resolve({ ok: false as const, error: "unauthenticated" }),
    });
    expect(response.status).toBe(401);
  });
});
