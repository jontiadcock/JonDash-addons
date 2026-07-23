import { describe, it, expect } from "vitest";
import { digest, shouldNotify, type DigestLine } from "../lib/notify";
import type { Job } from "../lib/store";

/**
 * The alerting is what makes a silent failure noisy, so its own logic needs to be right.
 * Two things matter: the digest must lead with bad news rather than bury it, and a broken
 * job must not be able to send a thousand emails overnight.
 */

const bytes = (n: number) => `${Math.round(n / 1024)} KB`;

const line = (over: Partial<DigestLine> = {}): DigestLine => ({
  name: "Photos",
  runs: 7,
  failures: 0,
  lastSuccess: "2026-07-23",
  bytes: 1024,
  paused: false,
  ...over,
});

describe("digest", () => {
  it("leads with failures when there are any", () => {
    const text = digest([line(), line({ name: "Docs", failures: 2 })], 7, bytes);
    expect(text.split("\n")[0]).toMatch(/1 of your 2 backups had failures/);
  });

  it("says plainly that all is well when it is", () => {
    const text = digest([line(), line({ name: "Docs" })], 7, bytes);
    expect(text.split("\n")[0]).toMatch(/All 2 backups are healthy/);
  });

  it("marks a failing job in a way you cannot skim past", () => {
    const text = digest([line({ failures: 3 })], 7, bytes);
    expect(text).toContain("3 FAILED");
  });

  it("calls out jobs that did not run at all — the quiet failure", () => {
    const text = digest([line({ name: "Docs", runs: 0 })], 7, bytes);
    expect(text).toMatch(/Not run at all in this period: Docs/);
  });

  it("does not accuse a paused job of having stopped", () => {
    const text = digest([line({ name: "Docs", runs: 0, paused: true })], 7, bytes);
    expect(text).not.toMatch(/Not run at all/);
    expect(text).toContain("paused");
  });

  it("says a never-successful job has never succeeded, rather than showing a blank", () => {
    expect(digest([line({ lastSuccess: null })], 7, bytes)).toContain("never succeeded");
  });

  it("explains why its own absence matters", () => {
    expect(digest([line()], 7, bytes)).toMatch(/If it stops arriving/);
  });
});

describe("shouldNotify — rate limiting", () => {
  const job = (over: Partial<Job> = {}) =>
    ({ notifyEmail: "a@b.c", notifyWebhook: "", everyHours: 24, lastNotifiedAt: null, ...over }) as Job;

  it("stays silent when no channel is configured", () => {
    expect(shouldNotify(job({ notifyEmail: "", notifyWebhook: "" }))).toBe(false);
  });

  it("sends the first time", () => {
    expect(shouldNotify(job())).toBe(true);
  });

  it("does not send again within the job's own interval", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(shouldNotify(job({ lastNotifiedAt: recent }))).toBe(false);
  });

  it("sends again once the interval has passed", () => {
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    expect(shouldNotify(job({ lastNotifiedAt: old }))).toBe(true);
  });

  it("treats an unreadable timestamp as 'never notified' rather than staying quiet", () => {
    // Failing open matters here: the wrong direction to be wrong in is silence.
    expect(shouldNotify(job({ lastNotifiedAt: "not a date" }))).toBe(true);
  });
});
