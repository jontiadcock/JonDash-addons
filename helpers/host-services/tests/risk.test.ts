import { describe, expect, it } from "vitest";
import { assessRisk } from "../lib/risk";

describe("assessRisk", () => {
  it("warns about the services that end your way back into the machine", () => {
    for (const n of ["sshd", "ssh.service", "openssh-server", "OpenSSH SSH Server"]) {
      expect(assessRisk(n).level).toBe("lockout");
    }
    for (const n of ["MpsSvc", "ufw", "iptables", "NetworkManager", "Dhcp"]) {
      expect(assessRisk(n).level).toBe("lockout");
    }
  });

  it("warns about stopping JonDash from inside JonDash", () => {
    const r = assessRisk("JonDash");
    expect(r.level).toBe("lockout");
    expect(r.message).toMatch(/nothing running that could start it again/i);
  });

  it("flags disruptive-but-recoverable services more softly", () => {
    for (const n of ["docker", "mariadb", "postgresql", "vmms"]) {
      expect(assessRisk(n).level).toBe("caution");
    }
  });

  it("stays quiet on ordinary services, so warnings keep being read", () => {
    for (const n of ["Plex", "sonarr", "my-app", "jellyfin"]) {
      expect(assessRisk(n).level).toBe("none");
      expect(assessRisk(n).message).toBe("");
    }
  });

  it("ignores platform decoration when matching", () => {
    expect(assessRisk("sshd.service").level).toBe("lockout");
    expect(assessRisk("SSHD.EXE").level).toBe("lockout");
  });

  it("names the service back to the admin so the warning is recognisable", () => {
    expect(assessRisk("sshd").message).toContain('"sshd"');
  });

  it("handles empty input without inventing a risk", () => {
    expect(assessRisk("").level).toBe("none");
    expect(assessRisk("   ").level).toBe("none");
  });
});
