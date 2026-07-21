import "server-only";
import type { ModuleContext } from "@/lib/modules/types";

/**
 * Every database read and write in one place.
 *
 * `ctx.db` is the scoped SQL handle JonDash gives a module that ships migrations. It can
 * only reach your own `mod_<id>_*` tables, and `ctx.db.table("items")` resolves the
 * physical name for you — never hardcode it, or renaming your module breaks everything.
 *
 * Values always go in as bound `?` parameters. Never build SQL by concatenating a
 * string, even one you think is safe.
 */

type Db = NonNullable<ModuleContext["db"]>;

export type Item = { id: number; text: string; createdAt: string };

/** SQLite returns COUNT() as a BigInt often enough that coercing is always right. */
function toNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

export async function listItems(db: Db, limit = 50): Promise<Item[]> {
  return db.query<Item>(
    `SELECT id, text, createdAt FROM ${db.table("items")} ORDER BY id DESC LIMIT ?`,
    limit,
  );
}

export async function countItems(db: Db): Promise<number> {
  const rows = await db.query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${db.table("items")}`);
  return toNumber(rows[0]?.n);
}

export async function addItem(db: Db, text: string): Promise<void> {
  await db.run(
    `INSERT INTO ${db.table("items")} (text, createdAt) VALUES (?, ?)`,
    text,
    new Date().toISOString(),
  );
}

export async function deleteItem(db: Db, id: number): Promise<void> {
  await db.run(`DELETE FROM ${db.table("items")} WHERE id = ?`, id);
}
