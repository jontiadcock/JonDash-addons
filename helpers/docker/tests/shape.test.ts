import { describe, expect, it } from "vitest";
import { toContainer, toStats, toLines } from "../lib/shape";
import { demux, isValidId, VERBS } from "../lib/engine";
import type { RawContainer, RawStats } from "../lib/engine";

const raw = (over: Partial<RawContainer> = {}): RawContainer => ({
  Id: "abc123def456",
  Names: ["/plex"],
  Image: "linuxserver/plex:latest",
  State: "running",
  Status: "Up 3 days (healthy)",
  Created: 1_700_000_000,
  Labels: {},
  Ports: [],
  ...over,
});

describe("isValidId", () => {
  it("refuses anything that could traverse into another endpoint", () => {
    // The reason the pattern is anchored: `abc/../../images/prune` must not be expressible.
    for (const bad of ["abc/../images/prune", "a/b", "a?x=1", "a b", "", "-abc", "a#b", "a%2f"]) {
      expect(isValidId(bad)).toBe(false);
    }
  });

  it("accepts real ids and names", () => {
    for (const good of ["abc123def456", "plex", "my_container-1.0", "A".repeat(64)]) {
      expect(isValidId(good)).toBe(true);
    }
  });
});

describe("VERBS", () => {
  it("contains no way to run code", () => {
    expect(VERBS).toEqual(["start", "stop", "restart", "pause", "unpause"]);
    for (const forbidden of ["exec", "create", "remove", "kill", "commit"]) {
      expect(VERBS as string[]).not.toContain(forbidden);
    }
  });
});

describe("toContainer", () => {
  it("strips the leading slash Docker puts on names", () => {
    expect(toContainer(raw()).name).toBe("plex");
  });

  it("falls back to a SHORT id when a container has no name", () => {
    // Must be a full 64-char id, not the 12-char default fixture — anything shorter passes
    // without ever exercising the truncation this test is meant to check.
    const long = "a1b2c3d4e5f6".repeat(5) + "abcd"; // 64 chars
    expect(toContainer(raw({ Names: [], Id: long })).name).toBe("a1b2c3d4e5f6");
  });

  it("reads health out of the status string", () => {
    expect(toContainer(raw({ Status: "Up 3 days (healthy)" })).health).toBe("healthy");
    expect(toContainer(raw({ Status: "Up 2 minutes (unhealthy)" })).health).toBe("unhealthy");
    expect(toContainer(raw({ Status: "Up 5 seconds (health: starting)" })).health).toBe("starting");
    expect(toContainer(raw({ Status: "Up 3 days" })).health).toBe("none");
  });

  it("never invents a state the engine did not report", () => {
    expect(toContainer(raw({ State: "wormhole" })).state).toBe("dead");
  });

  it("keeps an unpublished port as null rather than 0", () => {
    // 0 would render as a real port number; null renders as "not published".
    const c = toContainer(raw({ Ports: [{ PrivatePort: 32400, Type: "tcp" }] }));
    expect(c.ports[0]).toEqual({ private: 32400, public: null, protocol: "tcp" });
  });

  it("picks up Compose project and service when present", () => {
    const c = toContainer(
      raw({ Labels: { "com.docker.compose.project": "media", "com.docker.compose.service": "plex" } }),
    );
    expect([c.project, c.service]).toEqual(["media", "plex"]);
  });
});

describe("toStats", () => {
  const base: RawStats = {
    cpu_stats: { cpu_usage: { total_usage: 2_000_000 }, system_cpu_usage: 20_000_000, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000 },
    memory_stats: { usage: 512 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
  };

  it("computes CPU the way Docker does — share of system delta, scaled by cores", () => {
    expect(toStats(base).cpuPct).toBe(40); // (1e6/1e7) * 4 * 100
  });

  it("returns 0 rather than NaN when there is no previous sample", () => {
    // A container that started a moment ago has no delta, and NaN% reads as a bug.
    const s = toStats({ ...base, precpu_stats: { cpu_usage: { total_usage: 0 } } });
    expect(Number.isFinite(s.cpuPct)).toBe(true);
  });

  it("does not divide by a zero memory limit", () => {
    const s = toStats({ ...base, memory_stats: { usage: 100, limit: 0 } });
    expect(s.memoryPct).toBe(0);
  });

  it("caps CPU at 100", () => {
    const s = toStats({
      ...base,
      cpu_stats: { cpu_usage: { total_usage: 999_000_000 }, system_cpu_usage: 20_000_000, online_cpus: 64 },
    });
    expect(s.cpuPct).toBeLessThanOrEqual(100);
  });
});

describe("demux", () => {
  function frame(stream: number, text: string): Buffer {
    const payload = Buffer.from(text, "utf8");
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload]);
  }

  it("strips the 8-byte frame headers a non-TTY container uses", () => {
    // Left in, these appear as control bytes mid-line and get reported as corruption.
    const body = Buffer.concat([frame(1, "hello\n"), frame(2, "a warning\n")]);
    expect(demux(body)).toBe("hello\na warning\n");
  });

  it("passes an unframed TTY stream through untouched", () => {
    expect(demux(Buffer.from("plain output\n", "utf8"))).toBe("plain output\n");
  });

  it("keeps what it has when the last frame is truncated", () => {
    const good = frame(1, "first\n");
    const cut = frame(1, "second").subarray(0, 10);
    expect(demux(Buffer.concat([good, cut]))).toContain("first");
  });
});

describe("toLines", () => {
  it("drops trailing blank lines and honours the tail", () => {
    expect(toLines("a\nb\nc\n\n\n", 10)).toEqual(["a", "b", "c"]);
    expect(toLines("a\nb\nc\n", 2)).toEqual(["b", "c"]);
  });

  it("handles CRLF, which Windows containers emit", () => {
    expect(toLines("a\r\nb\r\n", 10)).toEqual(["a", "b"]);
  });
});
