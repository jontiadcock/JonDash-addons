import type { HelperDefinition } from "@/lib/helpers/types";

/**
 * Docker helper — lets a module see and control containers on this server.
 *
 * ⚠ The one fact that shapes the whole design: the Docker socket is root-equivalent — reaching
 * it can start a container that mounts the host filesystem as root. So this helper exposes only
 * operations, never the socket: no call here takes a path, a method or a body.
 *
 * ⚠ No `exec`, ever — running a command in a container is arbitrary code execution as root on
 * the host, the exact thing this design exists to prevent. A console, if ever wanted, is a
 * separate capability with its own red line, not a quiet addition to `docker:manage`. Same
 * reasoning rules out container creation/removal and image or volume operations.
 */
const helper: HelperDefinition = {
  id: "docker",
  name: "Docker",
  description:
    "Lets a module see the containers on this server and start, stop, pause and restart them. It cannot run commands inside a container, create or delete one, or touch images and volumes.",
  version: "0.0.5",
  // Raised for CORE-10's optional `label`/`risk` (an older core fails to compile, TS2353). Must
  // stay the PRE-RELEASE string — a bare "1.7.2" would be refused on every 1.7.2 beta build.
  minAppVersion: "1.7.2-beta.1",

  /**
   * Three capabilities; `docker:logs` is split from `docker:read` deliberately. Seeing a
   * container is running is not the same as reading what it printed — logs routinely carry
   * connection strings, keys and personal data, so a status-only module needn't disclose the
   * power to read them, and an admin sees that power on its own line when it IS asked for.
   */

  /**
   * ⚠ No `scope` on any of these — deliberately, and this must not change. Every other acting
   * capability here is bounded by an admin-owned set (approved services, approved folders);
   * Docker gets none, because containers churn: a Compose `up` destroys and recreates them
   * with new ids, so an approved list goes stale every deploy and decays into re-approving
   * the same things forever — unlike services or folders, containers are not stable identities.
   *
   * The bound didn't disappear, it changed axis: CORE-10 grants are per (module, capability),
   * so the real control is WHICH MODULES may manage Docker. Core renders a scope-less
   * capability as a plain switch, and that switch IS the control — do not add a container
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
