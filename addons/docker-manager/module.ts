import type { ModuleDefinition } from "@/lib/modules/types";
import DockerWidget from "./ui/widget";
import DockerPage from "./page";
import DockerSettings from "./ui/settings-panel";

/**
 * Docker manager — see and control the containers on this server, and install Docker if it
 * isn't there yet.
 *
 * The module touches no container and no socket; it cannot. Every read and every action goes
 * through the `docker` helper, which exposes operations rather than the engine. What it can
 * never do is a property of that helper's API rather than a promise made here: no running
 * commands inside a container, no creating or deleting one, no image or volume operations.
 *
 * **It declares two helpers, and that makes the consent screen heavy** — five red lines. That
 * is the honest cost of the install button being built in rather than living somewhere else:
 * a module that can install software has to say so, even though most of the time it is only
 * showing you a list of containers.
 */
const dockerManager: ModuleDefinition = {
  id: "docker-manager",
  name: "Docker manager",
  description:
    "See the containers on this server and start, stop, pause and restart them. Shows you how to install Docker if it isn't set up yet, and can install it for you.",
  version: "0.0.5-beta.2",
  // The floor comes from host-install, which needs core's package API (1.7.1-beta.7). The
  // docker helper alone would run on 1.5.2. The PRE-RELEASE, not a bare "1.7.1": semver ranks
  // a pre-release below its release, so "1.7.1" would be refused on every 1.7.1 beta.
  minAppVersion: "1.7.2-beta.1",

  permissions: ["docker:read", "docker:logs", "docker:manage", "host-install:read", "host-install:manage"],

  helpers: [
    { id: "docker", minVersion: "0.0.2-beta.1" },
    { id: "host-install", minVersion: "0.0.2-beta.1" },
  ],

  /** What runs on this machine, and the power to stop it, is admin information. */
  adminOnly: true,

  DashboardWidget: DockerWidget,
  Page: DockerPage,
  SettingsPanel: DockerSettings,
};

export default dockerManager;
