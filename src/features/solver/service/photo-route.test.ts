import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { solverSessions } from "@/lib/db/schema";
import {
  createTestDatabase,
  DB_TEST_TIMEOUT,
  USER_A,
  USER_B,
  type TestDatabase,
} from "@/lib/db/test-harness";
import { createMemoryStore, type MemoryStore } from "@/lib/storage/memory";
import { makePhoto, seedSession } from "../test-support";
import { photoKey, photoStagingKey } from "./keys";
import { handleSolverPhotoRequest, type SolverPhotoDeps } from "./photo-route";

let database: TestDatabase;
let store: MemoryStore;
const PHOTO = makePhoto("jpeg", 10, 10);

beforeAll(async () => {
  database = await createTestDatabase();
}, DB_TEST_TIMEOUT);
afterAll(async () => {
  await database.client.close();
});
beforeEach(async () => {
  store = createMemoryStore();
  await database.db.execute(sql`truncate solver_sessions restart identity cascade`);
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

function deps(userId: string, inline: boolean): SolverPhotoDeps {
  return {
    authorize: signedIn(userId),
    db: database.db,
    store: () => store,
    inline: () => inline,
  };
}

async function seedPhoto(ownerId = USER_A, stage: "photo" | "upload" = "photo") {
  const id = await seedSession(database.db, {
    ownerId,
    inputKind: "photo",
    status: "needs_confirmation",
    confirmedMd: null,
  });
  const key =
    stage === "photo"
      ? photoKey(ownerId, id, "jpg")
      : photoStagingKey(ownerId, id, "jpg");
  await store.put(key, PHOTO, "image/jpeg");
  await database.db
    .update(solverSessions)
    .set({ inputKey: key })
    .where(eq(solverSessions.id, id));
  return { id, key };
}

describe("GET /api/solve/[id]/photo", () => {
  it("serves the owner's photo inline from the development store", async () => {
    const { id } = await seedPhoto();
    const response = await handleSolverPhotoRequest(id, deps(USER_A, true));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PHOTO);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("redirects to a 5-minute signed URL when photos are in R2", async () => {
    const { id, key } = await seedPhoto();
    const response = await handleSolverPhotoRequest(id, deps(USER_A, false));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe(`/${key}`);
    expect(location.searchParams.get("expires")).toBe("300");
  });

  it("answers 404 for another teacher's session, a trashed one, an unfinished upload, a deleted photo or a bad id", async () => {
    const { id } = await seedPhoto(USER_A);
    expect((await handleSolverPhotoRequest(id, deps(USER_B, true))).status).toBe(404);
    expect((await handleSolverPhotoRequest(id, deps(USER_B, false))).status).toBe(404);
    expect((await handleSolverPhotoRequest("../x", deps(USER_A, true))).status).toBe(404);
    const staged = await seedPhoto(USER_A, "upload");
    expect((await handleSolverPhotoRequest(staged.id, deps(USER_A, true))).status).toBe(
      404,
    );
    await database.db
      .update(solverSessions)
      .set({ inputKey: null })
      .where(eq(solverSessions.id, staged.id));
    expect((await handleSolverPhotoRequest(staged.id, deps(USER_A, true))).status).toBe(
      404,
    );
    await database.db
      .update(solverSessions)
      .set({ deletedAt: new Date() })
      .where(eq(solverSessions.id, id));
    expect((await handleSolverPhotoRequest(id, deps(USER_A, true))).status).toBe(404);
  });

  it("answers 401 to a signed-out caller", async () => {
    const { id } = await seedPhoto();
    const response = await handleSolverPhotoRequest(id, {
      ...deps(USER_A, true),
      authorize: () => Promise.resolve({ ok: false as const, error: "unauthenticated" }),
    });
    expect(response.status).toBe(401);
  });
});
