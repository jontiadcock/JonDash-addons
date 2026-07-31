import type { ModuleDefinition } from "@/lib/modules/types";
import DockerWidget from "./ui/widget";
import DockerPage from "./page";
import DockerSettings from "./ui/settings-panel";

/**
 * Docker manager — see and control the containers on this server, and install Docker if it
 * isn't there yet.
 *
 * ⚠ The module touches no container and no socket; it cannot. Every read and action goes
 * through the `docker` helper, which exposes operations rather than the engine — no exec
 * inside a container, no creating or deleting one, no image or volume operations. That is
 * the helper's API, not a promise made here.
 *
 * Declaring two helpers makes the consent screen heavy — five red lines, the honest cost of
 * the install button being built in rather than living somewhere else.
 */
const dockerManager: ModuleDefinition = {
  id: "docker-manager",
  name: "Docker manager",
  description:
    "See the containers on this server and start, stop, pause and restart them. Shows you how to install Docker if it isn't set up yet, and can install it for you.",
  version: "0.0.7-beta.1",
  // Floor is host-install's need for core's package API (1.7.1-beta.7); docker alone needs only
  // 1.5.2. Must stay the PRE-RELEASE string — a bare "1.7.1" would refuse every 1.7.1 beta.
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
