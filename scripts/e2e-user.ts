import {
  E2E_FAKE_ADMIN_USER,
  E2E_FAKE_PENDING_USER,
  E2E_FAKE_USER,
} from "../src/features/auth/service/e2e-session";

type Run = (query: string, params: unknown[]) => Promise<unknown>;

async function seedIdentity(
  run: Run,
  identity: { id: string; email: string },
  name: string,
): Promise<string> {
  const { id, email } = identity;
  await run(
    `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)
     on conflict do nothing`,
    [id, name, email],
  );
  await run(
    "insert into profiles (id, display_name) values ($1, $2) on conflict do nothing",
    [id, name],
  );
  return id;
}

// Inserts the fake teacher (the seam's one fixed identity) into "user" and profiles; safe to run
// repeatedly.
export function seedFakeUser(run: Run): Promise<string> {
  return seedIdentity(run, E2E_FAKE_USER, "Guru Uji");
}

// The second fixed identity, a verified account that CI's approval list does not name (pending).
export function seedFakePendingUser(run: Run): Promise<string> {
  return seedIdentity(run, E2E_FAKE_PENDING_USER, "Guru Menunggu");
}

// The third fixed identity: a verified account that the approval list does not name either, but
// whose address is ADMIN_EMAIL in the e2e environment, so the gate approves it as the admin.
export function seedFakeAdminUser(run: Run): Promise<string> {
  return seedIdentity(run, E2E_FAKE_ADMIN_USER, "Admin Uji");
}
