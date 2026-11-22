import { sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  pgPolicy,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./columns";
import { authenticatedRole } from "./roles";

const readPolicy = (name: string) =>
  pgPolicy(`${name}_read`, { for: "select", to: authenticatedRole, using: sql`true` });

export const curriculumVersions = pgTable.withRLS(
  "curriculum_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    title: text("title").notNull(),
    sourceTitle: text("source_title").notNull(),
    sourceUrl: text("source_url").notNull(),
    decreeRef: text("decree_ref"),
    publishedOn: date("published_on").notNull(),
    retrievedOn: date("retrieved_on").notNull(),
    status: text("status").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "curriculum_versions_status_check",
      sql`${t.status} in ('draft', 'active', 'archived')`,
    ),
    readPolicy("curriculum_versions"),
  ],
);

export const cpElements = pgTable.withRLS(
  "cp_elements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    curriculumVersionId: uuid("curriculum_version_id")
      .notNull()
      .references(() => curriculumVersions.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    outcomeText: text("outcome_text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("cp_elements_version_code_unique").on(t.curriculumVersionId, t.code),
    readPolicy("cp_elements"),
  ],
);

export const topics = pgTable.withRLS(
  "topics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    curriculumVersionId: uuid("curriculum_version_id")
      .notNull()
      .references(() => curriculumVersions.id, { onDelete: "cascade" }),
    cpElementId: uuid("cp_element_id")
      .notNull()
      .references(() => cpElements.id, { onDelete: "cascade" }),
    grade: smallint("grade").notNull(),
    stableKey: text("stable_key").notNull(),
    title: text("title").notNull(),
    scopeNotes: text("scope_notes").notNull(),
    sourceRef: text("source_ref").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check("topics_grade_check", sql`${t.grade} in (7, 8, 9)`),
    unique("topics_version_grade_key_unique").on(
      t.curriculumVersionId,
      t.grade,
      t.stableKey,
    ),
    readPolicy("topics"),
  ],
);

export const learningObjectives = pgTable.withRLS(
  "learning_objectives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    text: text("text").notNull(),
    sourceRef: text("source_ref").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("learning_objectives_topic_code_unique").on(t.topicId, t.code),
    readPolicy("learning_objectives"),
  ],
);
