import { pgRole } from "drizzle-orm/pg-core";

// The role every teacher-scoped query runs as (runAsUser does `set local role authenticated`).
// `.existing()`: Drizzle must never create, alter or drop it. The hand-written bootstrap
// migration creates it (guarded, since some hosts already ship a role with this name), and
// every policy in the schema targets it.
export const authenticatedRole = pgRole("authenticated").existing();
