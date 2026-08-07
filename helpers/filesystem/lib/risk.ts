import path from "node:path";
import { contains, isFilesystemRoot } from "./paths";

/**
 * Warnings about a chosen folder — what else is in there that the admin may not have
 * pictured. Exists because the helper stopped refusing broad locations: excluding JonDash's
 * own secrets (`secrets.ts`) makes a root safe for *JonDash*, and says nothing about the
 * rest of the disk — backing up `C:\` also carries browser password stores, SSH keys and
 * every other profile's credential caches onto the destination.
 *
 * Allow it, and say plainly what it means: a refusal the admin cannot override teaches them
 * to work around the tool, a warning they must read leaves them in charge with eyes open.
 *
 * Purely textual — no I/O, no throwing, safe to call on every keystroke while rendering a form.
 */

export type RiskLevel = "none" | "caution" | "high";

/** REFS helpers/filesystem/api.ts */
export type RootRisk = {
  level: RiskLevel;
  /** One line for the top of a warning box. Empty when level is "none". */
  headline: string;
  /** What is in there, in plain language. */
  reasons: string[];
  /** What the admin should consider doing instead. */
  advice: string[];
};

const none: RootRisk = { level: "none", headline: "", reasons: [], advice: [] };

/** Where user profiles live on this platform. */
function profileRoots(): string[] {
  if (process.platform === "win32") {
    const drive = process.env.SystemDrive || "C:";
    return [path.join(drive, "\\", "Users")];
  }
  return process.platform === "darwin" ? ["/Users"] : ["/home"];
}

/** Directories that are the operating system rather than anybody's data. */
function systemRoots(): string[] {
  if (process.platform === "win32") {
    return [
      process.env.SystemRoot ?? "C:\\Windows",
      process.env.ProgramFiles ?? "C:\\Program Files",
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      process.env.ProgramData ?? "C:\\ProgramData",
    ];
  }
  return ["/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var"];
}

/**
 * What an admin should know before backing this folder up. `p` must already be canonical
 * (see `canonicalise`), so comparisons are segment-aware and casing has been settled.
 *
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/admin.ts ·
 *      helpers/filesystem/lib/scopes.ts · helpers/filesystem/tests/risk.test.ts
 */
export function assessRoot(p: string, installDir = process.cwd()): RootRisk {
  const reasons: string[] = [];
  const advice: string[] = [];
  let level: RiskLevel = "none";

  const raise = (to: RiskLevel) => {
    if (to === "high" || (to === "caution" && level === "none")) level = to;
  };

  if (isFilesystemRoot(p)) {
    raise("high");
    reasons.push(
      "This is an entire drive, not a folder — it includes Windows itself, installed programs, and every user account on this machine.",
    );
    reasons.push(
      "Files that are in use — the page file, System Volume Information, other people's open documents — cannot be read, so the run will report a large number of errors it cannot avoid.",
    );
    advice.push("Back up the folders you actually care about instead, such as your Documents folder.");
  }

  for (const profiles of profileRoots()) {
    if (contains(profiles, p) || contains(p, profiles)) {
      raise("high");
      reasons.push(
        "This covers user profiles. Those hold saved browser passwords, SSH and cloud keys, and credential caches belonging to everyone with an account here.",
      );
      advice.push("If the destination is a shared drive, remember that anyone who can read it will get those too.");
      break;
    }
  }

  for (const sys of systemRoots()) {
    if (contains(sys, p) || contains(p, sys)) {
      raise("high");
      reasons.push("This covers operating-system files, which are not useful in a backup and cannot all be read.");
      break;
    }
  }

  if (contains(p, installDir) || contains(installDir, p)) {
    raise("caution");
    reasons.push(
      "This covers JonDash's own folder. Its secrets — the encryption key, the database, HTTPS private keys — are skipped automatically and listed in the run log.",
    );
    advice.push("To back up JonDash itself, use Admin → Backup, which produces a restorable file.");
  }

  if (level === "none") return none;

  return {
    level,
    headline:
      level === "high"
        ? "This folder holds far more than you may intend to copy."
        : "Worth knowing before you save this.",
    reasons,
    advice,
  };
}

/**
 * A short, stable summary for storing alongside a root and showing in a log header.
 * REFS helpers/filesystem/api.ts · helpers/filesystem/lib/admin.ts ·
 *      helpers/filesystem/tests/risk.test.ts
 */
export function riskSummary(r: RootRisk): string {
  return r.level === "none" ? "" : `${r.level}: ${r.reasons.join(" ")}`;
}
