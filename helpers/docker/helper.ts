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
  version: "0.0.1-beta.1",
  // `ctx.can()` arrived in 1.5.2 and every capability check here depends on it. The
  // PRE-RELEASE, not a bare "1.5.2": semver ranks a pre-release below its release, so "1.5.2"
  // would be refused on every 1.5.2 beta — the builds beta users run.
  minAppVersion: "1.5.2-beta.1",

  /**
   * Three capabilities, and `docker:logs` is split from `docker:read` deliberately.
   *
   * Seeing that a container is running is not the same as reading what it printed. Logs
   * routinely contain connection strings, API keys and personal data, so a module that only
   * needs a status tile should not have to disclose the power to read them — and an admin
   * should see that power on its own line when it IS asked for.
   */
  provides: [
    {
      permission: "docker:read",
      describe: () => "See the containers on this server — their names, images, state and resource use",
    },
    {
      permission: "docker:logs",
      describe: () => "Read container logs, which often contain passwords, keys and personal data",
    },
    {
      permission: "docker:manage",
      describe: () => "Start, stop, pause and restart containers on this server",
    },
  ],

  /**
   * No tables. Everything is read live from the engine, which is the only source that cannot
   * go stale — a cached container list is wrong the moment something restarts. No migrations
   * either, and nothing to clean up on uninstall: this helper creates nothing outside JonDash.
   */
};

export default helper;
