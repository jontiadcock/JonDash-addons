import os from "node:os";
import fsp from "node:fs/promises";

/**
 * Host telemetry collection — the whole privileged surface of this helper, and deliberately
 * small. Everything here reads sizes, counts and times from `node:os`, `fs.statfs` and (on
 * Linux) `/proc` & `/sys`. Nothing reads a file's *contents*, so this can never become a way
 * to reach `.data/secrets.json`. Dependency-free on purpose — no `systeminformation`, no
 * native module (see [[install-footprint]]).
 *
 * Cross-platform is the real work: the API is identical everywhere, the implementation
 * branches on `os.platform()`. Where a platform can't answer (Windows load average, a VM
 * with no thermal sensors), the field degrades to `null`/`[]` rather than throwing.
 */

export type DiskUsage = {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
};

export type Snapshot = {
  host: { hostname: string; platform: string; arch: string; uptimeSec: number };
  cpu: {
    model: string;
    cores: number;
    usedPct: number;
    load1: number | null;
    load5: number | null;
    load15: number | null;
  };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
  disks: DiskUsage[];
  temps: { label: string; celsius: number }[];
  takenAt: string;
};

const pct = (used: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;

// ---- CPU ------------------------------------------------------------------

/** Aggregate idle and total CPU ticks across every core, right now. */
function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

/**
 * Instantaneous CPU load, as a percentage, by sampling the tick counters twice a short
 * interval apart and looking at what fraction of the elapsed ticks were NOT idle. This is
 * the only cross-platform way to get "how busy is the CPU *now*"; `loadavg` is Unix-only and
 * means something subtly different.
 */
async function cpuUsedPct(sampleMs = 120): Promise<number> {
  const a = cpuTicks();
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = cpuTicks();
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

// ---- Disks ----------------------------------------------------------------

/** Pseudo/virtual filesystems that are not "a drive" to a person. Skipped on Linux. */
const PSEUDO_FS = new Set([
  "proc", "sysfs", "cgroup", "cgroup2", "tmpfs", "devtmpfs", "devpts", "mqueue",
  "hugetlbfs", "debugfs", "tracefs", "securityfs", "pstore", "bpf", "configfs",
  "fusectl", "autofs", "binfmt_misc", "ramfs", "nsfs", "rpc_pipefs", "squashfs",
  "overlay", "fuse.gvfsd-fuse", "efivarfs", "selinuxfs",
]);

async function statfsUsage(mount: string): Promise<DiskUsage | null> {
  try {
    const s = await fsp.statfs(mount);
    const bsize = Number(s.bsize);
    const total = Number(s.blocks) * bsize;
    const usableFree = Number(s.bavail) * bsize; // space a non-root user can actually use
    const used = total - Number(s.bfree) * bsize; // truly used (df's convention)
    if (total <= 0) return null;
    return {
      mount,
      totalBytes: total,
      usedBytes: used,
      freeBytes: usableFree,
      // df's Use%: used / (used + available), which excludes root-reserved blocks.
      usedPct: pct(used, used + usableFree),
    };
  } catch {
    return null; // unmounted, no media, or permission — just skip it
  }
}

/** `\040`-style octal escapes in /proc/mounts fields (spaces, tabs) back to characters. */
function unescapeMount(s: string): string {
  return s.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

async function linuxMounts(): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  try {
    const text = await fsp.readFile("/proc/mounts", "utf8");
    for (const line of text.split("\n")) {
      const parts = line.split(" ");
      if (parts.length < 3) continue;
      const mount = unescapeMount(parts[1]);
      const fstype = parts[2];
      if (PSEUDO_FS.has(fstype)) continue;
      if (seen.has(mount)) continue;
      seen.add(mount);
      out.push(mount);
    }
  } catch {
    return ["/"];
  }
  return out.length ? out : ["/"];
}

async function windowsDrives(): Promise<string[]> {
  const out: string[] = [];
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    // statfs itself is the existence test: it throws for an absent or empty drive.
    if (await statfsUsage(root)) out.push(root);
  }
  return out;
}

async function collectDisks(): Promise<DiskUsage[]> {
  const platform = os.platform();
  let mounts: string[];
  if (platform === "win32") {
    // windowsDrives already statfs'd each; re-collect for a uniform return shape.
    return (await windowsDrives().then((roots) => Promise.all(roots.map(statfsUsage)))).filter(
      (d): d is DiskUsage => d !== null,
    );
  } else if (platform === "linux") {
    mounts = await linuxMounts();
  } else {
    mounts = ["/"];
  }
  const results = await Promise.all(mounts.map(statfsUsage));
  return results.filter((d): d is DiskUsage => d !== null);
}

// ---- Temperatures (best-effort) -------------------------------------------

async function collectTemps(): Promise<{ label: string; celsius: number }[]> {
  if (os.platform() !== "linux") return []; // Windows needs WMI; out of scope for v1
  const base = "/sys/class/thermal";
  const out: { label: string; celsius: number }[] = [];
  try {
    const zones = await fsp.readdir(base);
    for (const zone of zones) {
      if (!zone.startsWith("thermal_zone")) continue;
      try {
        const raw = await fsp.readFile(`${base}/${zone}/temp`, "utf8");
        const milli = Number(raw.trim());
        if (!Number.isFinite(milli)) continue;
        let label = zone;
        try {
          label = (await fsp.readFile(`${base}/${zone}/type`, "utf8")).trim() || zone;
        } catch {
          /* keep the zone name */
        }
        out.push({ label, celsius: Math.round((milli / 1000) * 10) / 10 });
      } catch {
        /* skip an unreadable zone */
      }
    }
  } catch {
    return [];
  }
  return out;
}

// ---- The one public call --------------------------------------------------

/** A fresh reading of the whole host. Samples the CPU over ~120ms; everything else is instant. */
export async function snapshot(): Promise<Snapshot> {
  const isWin = os.platform() === "win32";
  const [usedPct, disks, temps] = await Promise.all([cpuUsedPct(), collectDisks(), collectTemps()]);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();
  const [l1, l5, l15] = os.loadavg();

  return {
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
    },
    cpu: {
      model: cpus[0]?.model?.trim() ?? "unknown",
      cores: cpus.length,
      usedPct: Math.round(usedPct * 10) / 10,
      // Windows reports [0,0,0]; report null so a module can hide the row rather than lie.
      load1: isWin ? null : l1,
      load5: isWin ? null : l5,
      load15: isWin ? null : l15,
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: totalMem - freeMem,
      freeBytes: freeMem,
      usedPct: pct(totalMem - freeMem, totalMem),
    },
    disks,
    temps,
    takenAt: new Date().toISOString(),
  };
}
