import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { runModuleMigrations } from "@/lib/modules/migrate";
import type { ModuleDefinition } from "@/lib/modules/types";

/**
 * The upgrade an existing install actually performs: 0.0.1 → 0.1.0.
 *
 * The version jump itself is not the risk — core tracks migrations by FILENAME, so skipping
 * a version cannot skip a migration. The risk is that `002` runs against a table already
 * holding an admin's jobs, and that `runModuleMigrations` has **no transaction**: statements
 * apply one at a time and the `ModuleMigration` row is written only after the whole file
 * succeeds. A part-applied file therefore re-runs from statement 1 next time, and SQLite has
 * no `ADD COLUMN IF NOT EXISTS` to survive that.
 *
 * So this drives core's real runner over the real SQL, in order, with real rows sitting in
 * the table across the upgrade — rather than asserting that the SQL parses.
 *
 * ## Why this lives OUTSIDE addons/backup-manager/
 *
 * A module's whole folder ships, and **the installer's verifier scans every file in it,
 * tests included**. This test needs `@/lib/db`, `@/lib/modules/migrate`, `node:fs` and
 * `process.env` — four things a module is forbidden to touch. Kept inside the module it made
 * the module fail verification and become uninstallable, which is exactly what happened to
 * `0.1.1-beta.1`. It is a maintainer's test of core's behaviour, not part of the artifact.
 *
 * Run it by copying it into a JonDash checkout (>= 1.5.4-beta.1) that has this module
 * installed, since it needs core's own vitest wiring — the `@` alias, the `server-only`
 * stub and a throwaway migrated DATABASE_URL:
 *   cp tests/backup-manager-upgrade.test.ts <jondash>/tests/
 *   cd <jondash> && npx vitest run tests/backup-manager-upgrade.test.ts
 *
 * The final case (rollback of a part-applied migration) needs the per-file transaction that
 * landed in **1.5.4-beta.1** (BUG-32). It fails against any earlier build, by design — that
 * is what proved the fix was needed.
 */

const MODULE_ID = "backup-manager";
const MIG_DIR = path.join(process.cwd(), "modules", MODULE_ID, "migrations");
const PATH_002 = path.join(MIG_DIR, "002_scheduling_and_reliability.sql");
// A throwaway migration used only by the rollback test. Sorts after 002, so it runs last.
const PATH_003 = path.join(MIG_DIR, "003_rollback_probe.sql");

const def = { id: MODULE_ID, migrations: "./migrations" } as ModuleDefinition;

/** 002 is withheld from disk to fake a 0.0.1 install, then restored. */
let sql002 = "";

async function tableInfo(table: string): Promise<{ name: string }[]> {
  return prisma.$queryRawUnsafe(`PRAGMA table_info(${table})`);
}

beforeAll(async () => {
  /**
   * This test DROPS this module's tables. Against a real install that is somebody's backup
   * configuration, so refuse anywhere that isn't obviously a disposable test database.
   * Vitest sets `DATABASE_URL` to `file:./vitest.db` in `vitest.config.ts`.
   */
  const url = process.env.DATABASE_URL ?? "";
  if (!/vitest|test/i.test(url)) {
    throw new Error(
      `Refusing to run: DATABASE_URL (${url || "unset"}) does not look like a test database. ` +
        `This test drops mod_backup_manager_* tables.`,
    );
  }

  sql002 = fs.readFileSync(PATH_002, "utf8");

  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mod_backup_manager_%'`,
  );
  for (const t of tables) await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t.name}"`);
  await prisma.moduleMigration.deleteMany({ where: { moduleId: MODULE_ID } });
});

// Restore 002 whatever happens, or a failed run leaves the module missing a migration file.
// Remove the throwaway 003 the rollback test writes, so the module folder is left as it shipped.
afterAll(() => {
  if (sql002) fs.writeFileSync(PATH_002, sql002, "utf8");
  fs.rmSync(PATH_003, { force: true });
});

describe("Backup Manager 0.0.1 → 0.1.0, through core's own migration runner", () => {
  it("installs as 0.0.1 would have: 001 only", async () => {
    fs.rmSync(PATH_002, { force: true });
    await runModuleMigrations(def);

    const applied = await prisma.moduleMigration.findMany({ where: { moduleId: MODULE_ID } });
    expect(applied.map((m) => m.filename)).toEqual(["001_init.sql"]);

    // The 0.1.0 columns must genuinely not exist yet, or this test proves nothing.
    const cols = (await tableInfo("mod_backup_manager_jobs")).map((c) => c.name);
    expect(cols).toContain("everyHours");
    expect(cols).not.toContain("scheduleKind");
  });

  it("carries an admin's existing job and run across the upgrade untouched", async () => {
    // A job as 0.0.1 would have written it: nightly at 2am, snapshot mode, retention on.
    await prisma.$executeRawUnsafe(
      `INSERT INTO mod_backup_manager_jobs
         (id, name, sourceRootId, destRootId, mode, everyHours, atMinute, enabled,
          nextRunAt, keepDaily, pruneEnabled, createdAt)
       VALUES ('job-old', 'Nightly photos', 'root-a', 'root-b', 'snapshot', 24, 120, 1,
               '2026-07-24T02:00:00.000Z', 7, 1, '2026-07-01T00:00:00.000Z')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO mod_backup_manager_runs (id, jobId, startedAt, state, filesCopied)
       VALUES ('run-old', 'job-old', '2026-07-22T02:00:00.000Z', 'done', 412)`,
    );

    // The update: 002 arrives with the new files.
    fs.writeFileSync(PATH_002, sql002, "utf8");
    await runModuleMigrations(def);

    const applied = await prisma.moduleMigration.findMany({
      where: { moduleId: MODULE_ID },
      orderBy: { filename: "asc" },
    });
    expect(applied.map((m) => m.filename)).toEqual([
      "001_init.sql",
      "002_scheduling_and_reliability.sql",
    ]);

    const jobs = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM mod_backup_manager_jobs WHERE id = 'job-old'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("Nightly photos");
    expect(jobs[0].mode).toBe("snapshot");
    expect(Number(jobs[0].pruneEnabled)).toBe(1);
    expect(jobs[0].nextRunAt).toBe("2026-07-24T02:00:00.000Z");

    const runs = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM mod_backup_manager_runs WHERE id = 'run-old'`,
    );
    expect(Number(runs[0].filesCopied)).toBe(412);
  });

  it("gives the pre-existing job defaults that keep it behaving exactly as it did", async () => {
    const jobs = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT scheduleKind, daysCsv, maxRetries, consecutiveFailures
         FROM mod_backup_manager_jobs WHERE id = 'job-old'`,
    );
    // 'interval' is what every 0.0.1 job did. A default of 'daily' here would silently
    // re-time every existing backup on somebody's server.
    expect(jobs[0].scheduleKind).toBe("interval");
    expect(jobs[0].daysCsv).toBe("");
    expect(Number(jobs[0].maxRetries)).toBe(0);
    expect(Number(jobs[0].consecutiveFailures)).toBe(0);

    const runs = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT attempt FROM mod_backup_manager_runs WHERE id = 'run-old'`,
    );
    expect(Number(runs[0].attempt)).toBe(1);
  });

  it("creates the settings table the new code reads on every tick", async () => {
    const cols = (await tableInfo("mod_backup_manager_settings")).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["key", "value"]));
  });

  it("is idempotent — a second update pass changes nothing", async () => {
    await runModuleMigrations(def);
    const applied = await prisma.moduleMigration.findMany({ where: { moduleId: MODULE_ID } });
    expect(applied).toHaveLength(2);
    const jobs = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM mod_backup_manager_jobs`,
    );
    expect(Number(jobs[0].c)).toBe(1);
  });

  /**
   * A fully-applied file, re-run because its `ModuleMigration` row was lost, throws rather
   * than corrupting anything. **This stays true with or without the transaction** — the
   * columns were committed by a run that succeeded, so there is nothing to roll back and
   * `ALTER TABLE ADD COLUMN` still collides. Left as-is when the transaction landed; the
   * case it describes did not change. The one that changed is the next test.
   */
  it("a fully-applied file, re-run unrecorded, throws duplicate column", async () => {
    await prisma.moduleMigration.deleteMany({
      where: { moduleId: MODULE_ID, filename: "002_scheduling_and_reliability.sql" },
    });
    await expect(runModuleMigrations(def)).rejects.toThrow(/duplicate column/i);

    // Leave the database consistent for anything that runs after this file.
    await prisma.moduleMigration.create({
      data: { moduleId: MODULE_ID, filename: "002_scheduling_and_reliability.sql" },
    });
  });

  /**
   * THE WEDGE, and the case core's per-file transaction fixes (BUG-32, JonDash 1.5.4-beta.1).
   *
   * Before: a file that failed part-way left its earlier statements committed while the file
   * stayed unrecorded, so the retry restarted at statement 1 and died on a column that now
   * existed — the same failure forever, recoverable only by hand.
   *
   * After: the whole file plus its "applied" record run in one transaction, so a mid-file
   * failure rolls back everything. Nothing is left behind and nothing is recorded, so a
   * corrected file applies cleanly on the next attempt.
   *
   * **This drives the REAL `runModuleMigrations`**, not a hand-rolled `$transaction` — the
   * point is to prove CORE's behaviour, not to re-implement it and test the copy. A throwaway
   * `003` is written into the migrations dir with a good statement then a bad one; `afterAll`
   * removes it.
   */
  it("rolls a part-applied file back, so a corrected retry succeeds (needs 1.5.4-beta.1)", async () => {
    const jobs = "mod_backup_manager_jobs";

    // A two-statement migration whose SECOND statement is invalid. Statement 1 would add a
    // column; if it survives the failure, there is no transaction.
    fs.writeFileSync(
      PATH_003,
      `ALTER TABLE ${jobs} ADD COLUMN probeOne TEXT NOT NULL DEFAULT '';\n` +
        `ALTER TABLE ${jobs} ADD COLUMN probeTwo NOT_A_TYPE(((;\n`,
      "utf8",
    );

    await expect(runModuleMigrations(def)).rejects.toThrow();

    // INVERTED (was .toContain before the fix): statement 1 must have rolled back with the
    // rest of the file, so probeOne does NOT exist.
    const afterFail = (await tableInfo(jobs)).map((c) => c.name);
    expect(afterFail).not.toContain("probeOne");
    expect(afterFail).not.toContain("probeTwo");

    // And the file must NOT be recorded as applied — the record is written inside the same
    // transaction, so it rolled back too.
    const applied = await prisma.moduleMigration.findMany({ where: { moduleId: MODULE_ID } });
    expect(applied.map((m) => m.filename)).not.toContain("003_rollback_probe.sql");

    // The payoff: a corrected 003 now applies cleanly, where before the retry was wedged
    // forever on "duplicate column probeOne".
    fs.writeFileSync(
      PATH_003,
      `ALTER TABLE ${jobs} ADD COLUMN probeOne TEXT NOT NULL DEFAULT '';\n` +
        `ALTER TABLE ${jobs} ADD COLUMN probeTwo TEXT NOT NULL DEFAULT '';\n`,
      "utf8",
    );
    await runModuleMigrations(def); // must not throw

    const afterFix = (await tableInfo(jobs)).map((c) => c.name);
    expect(afterFix).toContain("probeOne");
    expect(afterFix).toContain("probeTwo");
    const applied2 = await prisma.moduleMigration.findMany({ where: { moduleId: MODULE_ID } });
    expect(applied2.map((m) => m.filename)).toContain("003_rollback_probe.sql");
  });
});
