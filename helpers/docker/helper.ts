import type { HelperDefinition } from "@/lib/helpers/types";

/**
 * Docker helper — lets a module see and control containers on this server.
 *
 * **The one fact that shapes the whole design: the Docker socket is root-equivalent.** Anyone
 * who can reach it can start a container that mounts the host filesystem as root. So the
 * helper exposes *operations* and never the socket, and there is no call that takes a path, a
 * method or a body.
 *
 * **No `exec`, permanently.** Running a command inside a container is arbitrary code
 * execution, usually as root on the host. It is not a feature that was left out for time; it
 * is the thing this design exists to make impossible. A console, if ever wanted, is a
 * different capability with its own red line — not a quiet addition to `docker:manage`.
 *
 * No container creation or removal, and no image or volume operations, for the same reason:
 * each is a route to running code the admin never approved.
 */
const helper: HelperDefinition = {
  id: "docker",
  name: "Docker",
  description:
    "Lets a module see the containers on this server and start, stop, pause and restart them. It cannot run commands inside a container, create or delete one, or touch images and volumes.",
  version: "0.0.4",
  // Raised from 1.5.2-beta.1 for CORE-10. `label` and `risk` are optional to omit but not to
  // declare: against a 1.7.1 clone they fail to compile (TS2353), and a helper compiles into
  // the app, so an older core gets a failed build rather than a plainer screen.
  //
  // The PRE-RELEASE, not a bare "1.7.2": semver ranks a pre-release below its release, so
  // "1.7.2" would be refused on every 1.7.2 beta — the builds beta users run.
  minAppVersion: "1.7.2-beta.1",

  /**
   * Three capabilities, and `docker:logs` is split from `docker:read` deliberately.
   *
   * Seeing that a container is running is not the same as reading what it printed. Logs
   * routinely contain connection strings, API keys and personal data, so a module that only
   * needs a status tile should not have to disclose the power to read them — and an admin
   * should see that power on its own line when it IS asked for.
   */
  /**
   * ## No `scope` on any of these, deliberately — owner's decision, 2026-07-26
   *
   * Every other acting capability in this repo is bounded by an admin-owned set: approved
   * services, approved folders. Docker has none, and must not be given one.
   *
   * **Intent** — *"the intention behind installing docker is that you can manage it"*. A Docker
   * manager bounded to named containers is a file manager that asks permission per file.
   *
   * **Churn** — and this is the part that would make an allowlist fail rather than merely
   * annoy. A Compose `up` destroys and recreates containers with new ids, so an approved list
   * would go stale on every deploy and decay into re-approving the same things forever.
   * Services and folders are stable identities; containers are not. A bound that is wrong most
   * of the time teaches people to ignore it.
   *
   * **The bound did not disappear, it changed axis.** CORE-10 grants are per (module,
   * capability), so the real control is *which modules* may manage Docker — which is the useful
   * question here. Core renders a capability with no `scope` as a plain switch, and that switch
   * is the whole control. This is the intended path, not a gap: do not add a container
   * allowlist.
   */
  provides: [
    {
      permission: "docker:read",
      describe: () => "See the containers on this server — their names, images, state and resource use",
      label: "See containers",
      risk: "low",
    },
    {
      permission: "docker:logs",
      describe: () => "Read container logs, which often contain passwords, keys and personal data",
      // Higher than "see containers" and deliberately so: logs routinely carry connection
      // strings, tokens and personal data that nobody meant to publish.
      label: "Read container logs",
      risk: "high",
    },
    {
      permission: "docker:manage",
      describe: () => "Start, stop, pause and restart containers on this server",
      label: "Start and stop containers",
      risk: "high",
    },
  ],

  /**
   * No tables. Everything is read live from the engine, which is the only source that cannot
   * go stale — a cached container list is wrong the moment something restarts. No migrations
   * either, and nothing to clean up on uninstall: this helper creates nothing outside JonDash.
   */
};

export default helper;
