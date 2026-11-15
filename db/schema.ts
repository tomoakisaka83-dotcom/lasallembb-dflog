import { pgTable, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";

// One row per game (opponent, date, and every logged possession live in `data`).
export const games = pgTable("games", {
  id: text().primaryKey(),
  data: jsonb().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Single row (id = "main") holding the shared settings and a version counter
// used to detect two editors saving at the same time.
export const settings = pgTable("settings", {
  id: text().primaryKey(),
  cfg: jsonb().notNull(),
  version: integer().notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
