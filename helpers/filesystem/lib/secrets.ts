import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir, secretsPath } from "@/lib/config";

/**
 * The secret registry — what a backup must never carry off this machine.
 *
 * This replaces the old approach of refusing any source that touched the JonDash folder.
 * Refusing by path was both too strict and too weak: it blocked backing up `C:\` at all,
 * yet it protected nothing if the data directory had been relocated (`JONDASH_DATA_DIR`)
 * or the database moved (`DATABASE_URL`). A rule that can be walked around by moving a
 * file is not a rule.
 *
 * So this module answers a different question: **which files on disk ARE the secrets,
 * right now?** It resolves them from the same configuration the running app reads, and
 * then matches them by FILE IDENTITY rather than by name.
 *
 * ## Why identity beats path
 *
 * `fs.stat()` reports a volume serial (`dev`) and a file index (`ino`) — on NTFS as well
 * as POSIX. That pair is stable across a rename, a move within the volume, a hard link,
 * and any casing or junction used to reach the file. Verified on Windows: the same file
 * renamed, moved into a subfolder, reached via `SUB\DEEP.JSON`, and opened through a hard
 * link all report one identity. So a secret that has MOVED is still recognised, and a
 * secret reached by a sneaky second path cannot slip through under a different name.
 *
 * ## Three tiers, and the honest limit of each
 *
 *  1. **Identity** (below, `protectedIdentities`) — catches the live secrets wherever they
 *     now live, plus every alternative route to them. This is the load-bearing tier.
 *  2. **Content** (`protectedContent`) — a verbatim COPY of a secret is a different file
 *     with a different identity, so tier 1 cannot see it. Hashing small files catches
 *     `secrets.json.bak`. We also look for the master key's literal value, which catches
 *     the key pasted into someone's notes.
 *  3. **Nothing catches the rest.** A re-encoded secret, a key inside a screenshot, a
 *     value typed into a document — that is data-loss prevention, an entire product
 *     category, and it does not work reliably. This helper must not imply otherwise. What
 *     it promises is precise: *JonDash's own secrets, and verbatim copies of them.*
 *
 * Nothing here throws. A secret that cannot be resolved is simply one this pass could not
 * protect, and the caller reports that rather than failing the backup.
 */

/** How large a file may be before we stop content-checking it. Secrets are small. */
const SMALL_FILE_MAX = 64 * 1024;

/** A stable identity for a file or directory: volume serial + file index. */
export function identityOf(st: { dev: number | bigint; ino: number | bigint }): string {
  return `${st.dev}:${st.ino}`;
}

/**
 * Where Prisma's SQLite file actually is, from `DATABASE_URL`.
 *
 * A relative `file:./dev.db` is resolved against the `prisma/` directory, which is how
 * Prisma itself reads it — resolving against the process cwd instead would point at a
 * file that does not exist and silently protect nothing.
 */
function databaseFile(installDir: string): string | null {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) return null;
  const raw = url.slice("file:".length).trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(installDir, "prisma", raw);
}

/** Every path that holds, or could hold, something secret. Existence is not assumed. */
function candidatePaths(installDir: string): { path: string; reason: string }[] {
  const data = dataDir();
  const out: { path: string; reason: string }[] = [
    { path: data, reason: "JonDash's data folder (holds the master encryption key)" },
    { path: secretsPath(), reason: "JonDash's master encryption key" },
    { path: path.join(data, "tls"), reason: "JonDash's HTTPS private keys" },
    { path: path.join(data, "network.json"), reason: "JonDash's network configuration" },
    { path: path.join(installDir, ".env"), reason: "JonDash's environment file" },
  ];

  const db = databaseFile(installDir);
  if (db) {
    out.push({ path: db, reason: "JonDash's database (accounts, sessions, stored credentials)" });
    // SQLite's sidecars hold pages not yet folded into the main file — every bit as
    // sensitive, and easy to forget because they come and go.
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      out.push({ path: db + suffix, reason: "JonDash's database journal" });
    }
  }
  return out;
}

/**
 * Tier 1 — identities of the live secrets, mapped to why each is protected.
 *
 * Directories are included so a whole subtree can be skipped by one comparison: the walk
 * checks each directory's identity before descending, so `.data` is stepped over entirely
 * without needing to know what is inside it.
 */
export async function protectedIdentities(installDir = process.cwd()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const { path: p, reason } of candidatePaths(installDir)) {
    try {
      const st = await fs.stat(p);
      out.set(identityOf(st), reason);
    } catch {
      // Not present (or not readable). Nothing to protect at this location.
    }
  }
  return out;
}

/** Tier 2 — what a verbatim copy of a secret looks like. */
export type ProtectedContent = {
  /** sha256 of each small secret file, mapped to why it is protected. */
  hashes: Map<string, string>;
  /** Literal secret values (the master key) to look for inside other small files. */
  literals: string[];
};

/**
 * Tier 2 — content fingerprints, for copies that tier 1 cannot see by identity.
 *
 * The master key's literal value is included because the most common way a key escapes is
 * not a copied file, it is the value pasted somewhere. Sixty-four hex characters is
 * specific enough that a false positive is essentially impossible.
 */
export async function protectedContent(installDir = process.cwd()): Promise<ProtectedContent> {
  const hashes = new Map<string, string>();
  const literals: string[] = [];

  for (const { path: p, reason } of candidatePaths(installDir)) {
    try {
      const st = await fs.stat(p);
      if (!st.isFile() || st.size > SMALL_FILE_MAX) continue;
      const buf = await fs.readFile(p);
      hashes.set(crypto.createHash("sha256").update(buf).digest("hex"), reason);
    } catch {
      // Unreadable or absent — no fingerprint to take.
    }
  }

  // The key value itself, however the key is currently supplied.
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) literals.push(envKey.toLowerCase());
  try {
    const text = await fs.readFile(secretsPath(), "utf8");
    const parsed = JSON.parse(text) as { encryptionKey?: string };
    if (parsed?.encryptionKey && /^[0-9a-f]{64}$/.test(parsed.encryptionKey)) {
      literals.push(parsed.encryptionKey.toLowerCase());
    }
  } catch {
    // No key file, or not readable. Tier 1 still covers the file itself.
  }

  return { hashes, literals: [...new Set(literals)] };
}

/**
 * The whole registry, resolved once at the start of a run.
 *
 * Resolved per run rather than cached for the process lifetime: an admin may move the
 * database or rotate the key between runs, and a stale registry would protect a location
 * that no longer holds anything while missing the one that does.
 */
export type SecretRegistry = {
  identities: Map<string, string>;
  content: ProtectedContent;
  /** True when the master key could not be resolved at all — worth telling the admin. */
  keyUnresolved: boolean;
};

export async function loadRegistry(installDir = process.cwd()): Promise<SecretRegistry> {
  const [identities, content] = await Promise.all([
    protectedIdentities(installDir),
    protectedContent(installDir),
  ]);
  return { identities, content, keyUnresolved: content.literals.length === 0 };
}

/**
 * Is this file or directory protected? Returns the reason, or null.
 *
 * `stat` alone answers tier 1 and costs nothing — the walk has already taken it. The
 * content check is offered separately (`contentReason`) because it needs a read, and the
 * caller only pays for it on files it is actually about to copy.
 */
export function identityReason(reg: SecretRegistry, st: { dev: number | bigint; ino: number | bigint }): string | null {
  return reg.identities.get(identityOf(st)) ?? null;
}

/**
 * Tier 2 applied to one candidate file's bytes. Only worth calling for small files that
 * are about to be written to the destination — which is precisely where a leak would
 * happen, so nothing is given up by skipping the check on files we aren't copying.
 */
export function contentReason(reg: SecretRegistry, buf: Buffer): string | null {
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  const byHash = reg.content.hashes.get(hash);
  if (byHash) return `a copy of ${byHash}`;

  if (reg.content.literals.length) {
    // Only meaningful for text; a binary file containing the hex run would be a
    // remarkable coincidence, and skipping it is the safe direction to be wrong in.
    const text = buf.toString("latin1").toLowerCase();
    for (const literal of reg.content.literals) {
      if (text.includes(literal)) return "it contains JonDash's master encryption key";
    }
  }
  return null;
}

/** Files above this size are not content-checked. Exposed so the walk can avoid the read. */
export const CONTENT_CHECK_MAX_BYTES = SMALL_FILE_MAX;
