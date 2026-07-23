import { describe, it, expect } from "vitest";
import path from "node:path";
import { assessRoot, riskSummary } from "../lib/risk";

/**
 * Warnings replaced refusals in 0.0.2, so these are now the only thing standing between an
 * admin and copying their whole disk to a NAS without realising what is in it. A warning
 * that fails to fire is the new version of a deny-list hole.
 */

const WIN = process.platform === "win32";

describe("assessRoot", () => {
  it("says nothing about an ordinary folder", () => {
    const r = assessRoot(WIN ? "C:\\Data\\Invoices" : "/data/invoices", WIN ? "C:\\Apps\\JonDash" : "/opt/jondash");
    expect(r.level).toBe("none");
    expect(r.reasons).toHaveLength(0);
    expect(riskSummary(r)).toBe("");
  });

  it("flags a whole drive as high risk, and says why", () => {
    const r = assessRoot(WIN ? "C:\\" : "/", WIN ? "C:\\Apps\\JonDash" : "/opt/jondash");
    expect(r.level).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/entire drive/i);
    // The practical warning matters as much as the security one: a drive-wide run is
    // mostly permission errors, and an admin who isn't told assumes the tool is broken.
    expect(r.reasons.join(" ")).toMatch(/in use|cannot be read|errors/i);
    expect(r.advice.length).toBeGreaterThan(0);
  });

  it("flags user profiles, naming what is actually in them", () => {
    const profiles = WIN ? "C:\\Users" : process.platform === "darwin" ? "/Users" : "/home";
    const r = assessRoot(profiles, WIN ? "C:\\Apps\\JonDash" : "/opt/jondash");
    expect(r.level).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/password|ssh|key|credential/i);
  });

  it("flags a single profile too, not just the folder holding all of them", () => {
    const one = WIN ? "C:\\Users\\someone" : process.platform === "darwin" ? "/Users/someone" : "/home/someone";
    expect(assessRoot(one, WIN ? "C:\\Apps\\JonDash" : "/opt/jondash").level).toBe("high");
  });

  it("mentions JonDash's own folder as a caution, not a refusal", () => {
    const install = WIN ? "C:\\Apps\\JonDash" : "/opt/jondash";
    const r = assessRoot(install, install);
    expect(r.level).toBe("caution");
    expect(r.reasons.join(" ")).toMatch(/skipped/i);
    // Points at the feature that actually does this job properly.
    expect(r.advice.join(" ")).toMatch(/Backup/i);
  });

  it("does not warn about a normal network share — that is the ordinary destination", () => {
    if (!WIN) return;
    expect(assessRoot("\\\\nas\\backups", "C:\\Apps\\JonDash").level).toBe("none");
  });

  it("keeps the highest level when several concerns apply", () => {
    // A drive root also contains profiles and the OS; it must not be downgraded to caution
    // by a later, milder finding.
    const r = assessRoot(WIN ? "C:\\" : "/", WIN ? "C:\\Apps\\JonDash" : "/opt/jondash");
    expect(r.level).toBe("high");
  });

  it("summarises into one storable line", () => {
    const r = assessRoot(WIN ? "C:\\" : "/", WIN ? "C:\\Apps\\JonDash" : "/opt/jondash");
    expect(riskSummary(r).startsWith("high:")).toBe(true);
  });

  it("treats a folder CONTAINING the install directory as a caution as well", () => {
    const install = WIN ? "C:\\Apps\\JonDash" : "/opt/jondash";
    const parent = path.dirname(install);
    expect(assessRoot(parent, install).level).not.toBe("none");
  });
});
