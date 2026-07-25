import os from "node:os";
import fsp from "node:fs/promises";

/**
 * Host telemetry collection — the whole privileged surface of this helper, and deliberately
 * small. Everything here reads sizes, counts, rates and times from `node:os`, `fs.statfs` and
 * (on Linux) `/proc` & `/sys`. Nothing reads a file's *contents* for its content, so this can
 * never become a way to reach `.data/secrets.json`. Dependency-free on purpose — no
 * `systeminformation`, no native module.
 *
 * Cross-platform is the real work: the API is identical everywhere, the implementation
 * branches on `os.platform()`. Where a platform cannot answer, the field degrades to
 * `null`/`[]`/absent rather than throwing or inventing a zero.
 *
 * ## Collecting only what was asked for (0.0.2)
 *
 * Several groups cost real time: anything rate-based has to sample, wait, and sample again.
 * `collect` lets a consumer skip the ones it will not show, so a metric a user switched off
 * is never gathered rather than gathered and hidden. **All the rate-based groups share ONE
 * wait** — the "before" readings are taken together, then a single sleep, then the "after"
 * readings — so asking for CPU, network and disk rates costs the same wall-clock as asking
 * for CPU alone.
 */

// ---- Types ----------------------------------------------------------------

/** A group of readings that can be collected or skipped independently. */
export type MetricGroup =
  | "cpu"
  | "cpuCores"
  | "memory"
  | "swap"
  | "disks"
  | "diskIo"
  | "network"
  | "networkIo"
  | "temps"
  | "fans"
  | "battery";

export const ALL_GROUPS: MetricGroup[] = [
  "cpu", "cpuCores", "memory", "swap", "disks", "diskIo",
  "network", "networkIo", "temps", "fans", "battery",
];

export type DiskUsage = {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
};

export type DiskIo = {
  device: string;
  readBytesPerSec: number;
  writeBytesPerSec: number;
};

export type NetworkInterface = {
  name: string;
  addresses: string[];
  mac: string | null;
};

export type NetworkIo = {
  name: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
};

export type Swap = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
};

export type Battery = {
  /** 0–100, or null if the host reports charge some other way. */
  percent: number | null;
  /** "charging" | "discharging" | "full" | "unknown" — as the host words it, lowercased. */
  status: string;
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
    /** Clock speed in MHz, or null where the platform doesn't report it. Added in 0.0.2. */
    speedMhz?: number | null;
    /** Per-core busy percentages, in core order. Present only when `cpuCores` was collected. */
    perCore?: number[];
  };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
  disks: DiskUsage[];
  temps: { label: string; celsius: number }[];
  takenAt: string;

  // ---- added in 0.0.2, all optional so a 0.0.1 consumer is unaffected ----
  /** Swap / page file. `null` where the platform doesn't expose it (Windows). */
  swap?: Swap | null;
  /** Per-device read/write rates. Linux only; `[]` elsewhere. */
  diskIo?: DiskIo[];
  /** Non-loopback interfaces and their addresses. */
  network?: NetworkInterface[];
  /** Per-interface throughput. Linux only; `[]` elsewhere. */
  networkIo?: NetworkIo[];
  /** Fan speeds in RPM. Linux only; `[]` elsewhere. */
  fans?: { label: string; rpm: number }[];
  /** Battery / UPS state. Linux only, `null` where there is none. */
  battery?: Battery | null;
};

export type CollectOptions = {
  /** Which groups to gather. Omit for all of them. */
  collect?: MetricGroup[];
  /** Sampling window for rate-based groups, in ms. Clamped to 50–1000. */
  sampleMs?: number;
};

const pct = (used: number, total: number): number =>
  total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;

const round1 = (n: number) => Math.round(n * 10) / 10;

const isLinux = () => os.platform() === "linux";

// ---- CPU ------------------------------------------------------------------

type CoreTicks = { idle: number; total: number };

function cpuTicks(): { all: CoreTicks; perCore: CoreTicks[] } {
  const perCore: CoreTicks[] = [];
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    let coreTotal = 0;
    for (const v of Object.values(c.times)) coreTotal += v;
    perCore.push({ idle: c.times.idle, total: coreTotal });
    idle += c.times.idle;
    total += coreTotal;
  }
  return { all: { idle, total }, perCore };
}

/** Busy percentage between two tick readings. */
function busyPct(a: CoreTicks, b: CoreTicks): number {
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

// ---- /proc helpers --------------------------------------------------------

async function readProc(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** `/proc/meminfo` → a map of key to bytes (its values are in kB). */
async function meminfo(): Promise<Map<string, number> | null> {
  const text = await readProc("/proc/meminfo");
  if (!text) return null;
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB$/);
    if (m) out.set(m[1], Number(m[2]) * 1024);
  }
  return out;
}

async function collectSwap(): Promise<Swap | null> {
  // Windows has a page file but exposes no counter we can read without spawning a
  // process or a native module, so it is reported as absent rather than guessed at.
  if (!isLinux()) return null;
  const info = await meminfo();
  const total = info?.get("SwapTotal");
  const free = info?.get("SwapFree");
  if (total === undefined || free === undefined || total <= 0) return null;
  const used = total - free;
  return { totalBytes: total, usedBytes: used, freeBytes: free, usedPct: pct(used, total) };
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
  const text = await readProc("/proc/mounts");
  if (!text) return ["/"];
  for (const line of text.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const mount = unescapeMount(parts[1]);
    if (PSEUDO_FS.has(parts[2])) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);
    out.push(mount);
  }
  return out.length ? out : ["/"];
}

async function collectDisks(): Promise<DiskUsage[]> {
  const platform = os.platform();
  if (platform === "win32") {
    const roots: string[] = [];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      // statfs itself is the existence test: it throws for an absent or empty drive.
      if (await statfsUsage(`${letter}:\\`)) roots.push(`${letter}:\\`);
    }
    const results = await Promise.all(roots.map(statfsUsage));
    return results.filter((d): d is DiskUsage => d !== null);
  }
  const mounts = platform === "linux" ? await linuxMounts() : ["/"];
  const results = await Promise.all(mounts.map(statfsUsage));
  return results.filter((d): d is DiskUsage => d !== null);
}

// ---- Disk I/O (rate-based, Linux) -----------------------------------------

type IoCounters = Map<string, { read: number; write: number }>;

const SECTOR_BYTES = 512; // the unit /proc/diskstats always reports in, regardless of device

/** Partitions and virtual devices — the parent disk already covers their traffic. */
function isInterestingDisk(name: string): boolean {
  if (/^(loop|ram|dm-|zram|md)/.test(name)) return false;
  if (/^(sd[a-z]+|vd[a-z]+|hd[a-z]+)\d+$/.test(name)) return false; // sda1, vdb2 …
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false; // nvme0n1p1 …
  return true;
}

async function diskCounters(): Promise<IoCounters | null> {
  if (!isLinux()) return null;
  const text = await readProc("/proc/diskstats");
  if (!text) return null;
  const out: IoCounters = new Map();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    if (!isInterestingDisk(name)) continue;
    out.set(name, {
      read: Number(f[5]) * SECTOR_BYTES, // sectors read
      write: Number(f[9]) * SECTOR_BYTES, // sectors written
    });
  }
  return out;
}

function diffDiskIo(a: IoCounters | null, b: IoCounters | null, seconds: number): DiskIo[] {
  if (!a || !b || seconds <= 0) return [];
  const out: DiskIo[] = [];
  for (const [device, after] of b) {
    const before = a.get(device);
    if (!before) continue;
    const read = Math.max(0, after.read - before.read) / seconds;
    const write = Math.max(0, after.write - before.write) / seconds;
    out.push({ device, readBytesPerSec: Math.round(read), writeBytesPerSec: Math.round(write) });
  }
  return out.sort((x, y) => x.device.localeCompare(y.device));
}

// ---- Network --------------------------------------------------------------

function collectNetwork(): NetworkInterface[] {
  const out: NetworkInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!addrs) continue;
    const external = addrs.filter((a) => !a.internal); // drop loopback
    if (external.length === 0) continue;
    out.push({
      name,
      addresses: external.map((a) => a.address),
      mac: external[0]?.mac && external[0].mac !== "00:00:00:00:00:00" ? external[0].mac : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

type NetCounters = Map<string, { rx: number; tx: number }>;

async function netCounters(): Promise<NetCounters | null> {
  if (!isLinux()) return null;
  const text = await readProc("/proc/net/dev");
  if (!text) return null;
  const out: NetCounters = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === "lo") continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 9) continue;
    out.set(name, { rx: f[0], tx: f[8] });
  }
  return out;
}

function diffNetIo(a: NetCounters | null, b: NetCounters | null, seconds: number): NetworkIo[] {
  if (!a || !b || seconds <= 0) return [];
  const out: NetworkIo[] = [];
  for (const [name, after] of b) {
    const before = a.get(name);
    if (!before) continue;
    out.push({
      name,
      rxBytesPerSec: Math.round(Math.max(0, after.rx - before.rx) / seconds),
      txBytesPerSec: Math.round(Math.max(0, after.tx - before.tx) / seconds),
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

// ---- Temperatures & fans (best-effort, Linux) ------------------------------

async function collectTemps(): Promise<{ label: string; celsius: number }[]> {
  if (!isLinux()) return []; // Windows needs WMI; out of scope
  const base = "/sys/class/thermal";
  const out: { label: string; celsius: number }[] = [];
  let zones: string[];
  try {
    zones = await fsp.readdir(base);
  } catch {
    return [];
  }
  for (const zone of zones) {
    if (!zone.startsWith("thermal_zone")) continue;
    const raw = await readProc(`${base}/${zone}/temp`);
    if (raw === null) continue;
    const milli = Number(raw.trim());
    if (!Number.isFinite(milli)) continue;
    const type = await readProc(`${base}/${zone}/type`);
    out.push({ label: type?.trim() || zone, celsius: round1(milli / 1000) });
  }
  return out;
}

async function collectFans(): Promise<{ label: string; rpm: number }[]> {
  if (!isLinux()) return [];
  const base = "/sys/class/hwmon";
  const out: { label: string; rpm: number }[] = [];
  let chips: string[];
  try {
    chips = await fsp.readdir(base);
  } catch {
    return [];
  }
  for (const chip of chips) {
    let files: string[];
    try {
      files = await fsp.readdir(`${base}/${chip}`);
    } catch {
      continue;
    }
    const chipName = (await readProc(`${base}/${chip}/name`))?.trim() || chip;
    for (const file of files) {
      const m = file.match(/^fan(\d+)_input$/);
      if (!m) continue;
      const raw = await readProc(`${base}/${chip}/${file}`);
      const rpm = Number(raw?.trim());
      // A stopped or absent fan reads 0; reporting it as a fan at 0 RPM is noise.
      if (!Number.isFinite(rpm) || rpm <= 0) continue;
      const label = (await readProc(`${base}/${chip}/fan${m[1]}_label`))?.trim();
      out.push({ label: label || `${chipName} fan ${m[1]}`, rpm: Math.round(rpm) });
    }
  }
  return out;
}

// ---- Battery / UPS (Linux) -------------------------------------------------

async function collectBattery(): Promise<Battery | null> {
  if (!isLinux()) return null;
  const base = "/sys/class/power_supply";
  let entries: string[];
  try {
    entries = await fsp.readdir(base);
  } catch {
    return null;
  }
  for (const name of entries) {
    const type = (await readProc(`${base}/${name}/type`))?.trim();
    if (type !== "Battery") continue;
    const capacity = Number((await readProc(`${base}/${name}/capacity`))?.trim());
    const status = (await readProc(`${base}/${name}/status`))?.trim().toLowerCase() || "unknown";
    return {
      percent: Number.isFinite(capacity) ? Math.round(capacity) : null,
      status,
    };
  }
  return null;
}

// ---- The one public call --------------------------------------------------

/**
 * A fresh reading of the host.
 *
 * Rate-based groups (`cpu`, `diskIo`, `networkIo`) need two readings a moment apart. They
 * are gathered together around a SINGLE wait, so asking for all three costs the same
 * wall-clock as asking for one. Skipping all three makes the call effectively instant.
 */
export async function snapshot(opts: CollectOptions = {}): Promise<Snapshot> {
  const groups = new Set<MetricGroup>(opts.collect ?? ALL_GROUPS);
  const want = (g: MetricGroup) => groups.has(g);

  const sampleMs = Math.min(1000, Math.max(50, Math.trunc(opts.sampleMs ?? 120)));
  const needsSample = want("cpu") || want("cpuCores") || want("diskIo") || want("networkIo");

  // --- "before" readings for everything rate-based, taken together ---
  const ticksBefore = cpuTicks();
  const [diskBefore, netBefore] = await Promise.all([
    want("diskIo") ? diskCounters() : Promise.resolve(null),
    want("networkIo") ? netCounters() : Promise.resolve(null),
  ]);

  if (needsSample) await new Promise((r) => setTimeout(r, sampleMs));

  const ticksAfter = cpuTicks();
  const [diskAfter, netAfter] = await Promise.all([
    want("diskIo") ? diskCounters() : Promise.resolve(null),
    want("networkIo") ? netCounters() : Promise.resolve(null),
  ]);
  const seconds = sampleMs / 1000;

  // --- everything else, in parallel ---
  const [disks, temps, fans, battery, swap] = await Promise.all([
    want("disks") ? collectDisks() : Promise.resolve([] as DiskUsage[]),
    want("temps") ? collectTemps() : Promise.resolve([] as { label: string; celsius: number }[]),
    want("fans") ? collectFans() : Promise.resolve([] as { label: string; rpm: number }[]),
    want("battery") ? collectBattery() : Promise.resolve(null),
    want("swap") ? collectSwap() : Promise.resolve(null),
  ]);

  const isWin = os.platform() === "win32";
  const cpus = os.cpus();
  const [l1, l5, l15] = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const speed = cpus[0]?.speed;

  const snap: Snapshot = {
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptimeSec: Math.round(os.uptime()),
    },
    cpu: {
      model: cpus[0]?.model?.trim() ?? "unknown",
      cores: cpus.length,
      // When `cpu` wasn't asked for there is still a reading here — it just costs nothing,
      // being the average since boot rather than a live sample.
      usedPct: round1(busyPct(ticksBefore.all, ticksAfter.all)),
      // Windows reports [0,0,0]; report null so a consumer can hide the row rather than lie.
      load1: isWin ? null : l1,
      load5: isWin ? null : l5,
      load15: isWin ? null : l15,
      speedMhz: Number.isFinite(speed) && speed > 0 ? speed : null,
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

  if (want("cpuCores")) {
    snap.cpu.perCore = ticksAfter.perCore.map((after, i) =>
      round1(busyPct(ticksBefore.perCore[i] ?? after, after)),
    );
  }
  if (want("swap")) snap.swap = swap;
  if (want("diskIo")) snap.diskIo = diffDiskIo(diskBefore, diskAfter, seconds);
  if (want("network")) snap.network = collectNetwork();
  if (want("networkIo")) snap.networkIo = diffNetIo(netBefore, netAfter, seconds);
  if (want("fans")) snap.fans = fans;
  if (want("battery")) snap.battery = battery;

  return snap;
}
