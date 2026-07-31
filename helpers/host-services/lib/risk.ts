/**
 * Warnings shown when an admin adds a service to the allowlist.
 *
 * This helper does NOT refuse dangerous entries. An admin may have a good reason to control
 * their own firewall from their own dashboard, and a helper that decides it knows better
 * teaches people to work around it. What it must not do is let someone allowlist the thing
 * that will lock them out of the machine without saying so at the moment they do it.
 *
 * The failure mode is specific and unrecoverable-by-web-page: stop `sshd` from a browser on
 * a headless box and there is no route back in. Same for the firewall, the network stack,
 * and JonDash itself — stopping JonDash from JonDash means nothing is left running to start
 * it again.
 *
 * Mirrors the `filesystem` helper's risk warnings, which have held up: warn loudly, refuse
 * rarely, and never silently.
 */

export type RiskLevel = "none" | "caution" | "lockout";

/** REFS helpers/host-services/lib/allowlist.ts */
export type Risk = {
  level: RiskLevel;
  /** Shown to the admin verbatim. Written for a person, not a log. */
  message: string;
};

/**
 * Matched on the service/unit name, lowercased, with the platform's decoration removed
 * (`.service`, trailing `.exe`). Substring rather than exact match, because distributions
 * disagree — `ssh`, `sshd`, `ssh.service`, `openssh-server` are all the same risk.
 */
const LOCKOUT: { patterns: string[]; what: string; why: string }[] = [
  {
    patterns: ["sshd", "openssh", "ssh"],
    what: "remote access",
    why: "stopping it ends your only way back into a machine you are not sitting at",
  },
  {
    patterns: ["firewall", "iptables", "nftables", "ufw", "mpssvc", "windefend"],
    what: "the firewall or its security service",
    why: "stopping it can expose this machine, and starting it again may lock you out",
  },
  {
    patterns: ["network", "netman", "dhcp", "dnscache", "systemd-networkd", "networkmanager", "wpa_supplicant"],
    what: "the network stack",
    why: "stopping it takes this machine off the network, including this page",
  },
  {
    patterns: ["rpcss", "winlogon", "lsass", "systemd-logind", "dbus"],
    what: "a core operating-system service",
    why: "stopping it can make the machine unusable until it is restarted physically",
  },
  {
    patterns: ["jondash"],
    what: "JonDash itself",
    why: "stopping JonDash from inside JonDash leaves nothing running that could start it again",
  },
];

/** Services worth a softer note — losing them is disruptive but recoverable from here. */
const CAUTION: { patterns: string[]; what: string }[] = [
  { patterns: ["docker", "containerd", "podman"], what: "your container engine" },
  { patterns: ["mysql", "mariadb", "postgres", "mssql", "mongod", "redis"], what: "a database server" },
  { patterns: ["hyper-v", "vmms", "vboxdrv", "libvirt", "qemu"], what: "your hypervisor" },
];

function normalise(serviceName: string): string {
  return serviceName
    .toLowerCase()
    .replace(/\.service$/, "")
    .replace(/\.exe$/, "")
    .trim();
}

/**
 * Assess a service name an admin is about to allowlist.
 *
 * Deliberately conservative about `none`: an unrecognised service gets no warning, because
 * crying wolf on everything is how warnings stop being read.
 * REFS helpers/host-services/lib/allowlist.ts · helpers/host-services/tests/risk.test.ts
 */
export function assessRisk(serviceName: string): Risk {
  const n = normalise(serviceName);
  if (!n) return { level: "none", message: "" };

  for (const r of LOCKOUT) {
    if (r.patterns.some((p) => n.includes(p))) {
      return {
        level: "lockout",
        message:
          `"${serviceName}" looks like ${r.what}. If a module stops it, ${r.why}. ` +
          `You can still allow this — but know that recovering may need physical access to the machine.`,
      };
    }
  }

  for (const r of CAUTION) {
    if (r.patterns.some((p) => n.includes(p))) {
      return {
        level: "caution",
        message: `"${serviceName}" looks like ${r.what}. Anything relying on it will stop while it is down.`,
      };
    }
  }

  return { level: "none", message: "" };
}
