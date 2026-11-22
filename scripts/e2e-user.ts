import { E2E_FAKE_USER } from "../src/features/auth/service/e2e-session";

type Run = (query: string, params: unknown[]) => Promise<unknown>;

// Inserts the fake teacher (the seam's one fixed identity) into "user" and profiles; safe to run
// repeatedly.
export async function seedFakeUser(run: Run): Promise<string> {
  const { id, email } = E2E_FAKE_USER;
  await run(
    `insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)
     on conflict do nothing`,
    [id, "Guru Uji", email],
  );
  await run(
    "insert into profiles (id, display_name) values ($1, $2) on conflict do nothing",
    [id, "Guru Uji"],
  );
  return id;
}
