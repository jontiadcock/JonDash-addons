"use server";
import { moduleAction } from "@/lib/modules/api";
import { revalidatePath } from "next/cache";
import docker, { VERBS, type Verb } from "@/helpers/docker/api";
import hostInstall from "@/helpers/host-install/api";
import { MODULE_ID, MODULE_PATH, ADMIN_PATH, DOCKER_PACKAGE } from "./lib/constants";

/**
 * Everything that changes something.
 *
 * `moduleAction` wraps each handler: it asserts same-origin, refuses if the module is
 * disabled, and builds a context scoped to exactly the permissions this module declared.
 * Plain `<form action={…}>` server actions, so a button that stops a container does not
 * depend on a hydration step having succeeded.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const NOTICE = "lastNotice";

async function notice(
  ctx: Parameters<Parameters<typeof moduleAction>[1]>[0],
  tone: "ok" | "warn" | "bad",
  text: string,
): Promise<void> {
  await ctx.store?.set(NOTICE, { tone, text, at: new Date().toISOString() });
}

/**
 * Start, stop, restart, pause or unpause one container.
 * REFS addons/docker-manager/page.tsx
 */
export const containerAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const id = str(form, "id");
  const name = str(form, "name") || id.slice(0, 12);
  const verb = str(form, "verb") as Verb;

  if (!VERBS.includes(verb)) {
    await notice(ctx, "bad", "That is not an action this module can perform.");
  } else {
    const r = await docker(ctx).act(id, verb);
    // The engine's own wording is kept — "container already started" is more useful than
    // anything invented here.
    await notice(ctx, r.ok ? "ok" : "bad", r.ok ? `${name} — ${verb} done.` : `Could not ${verb} ${name}: ${r.reason}`);
  }
  revalidatePath(MODULE_PATH);
});

/**
 * Ask an administrator to install Docker.
 *
 * Inert on its own: this writes a request. An admin approves it in JonDash — seeing the
 * package id verbatim — and then Windows asks again.
 * REFS addons/docker-manager/ui/setup.tsx
 */
export const requestDockerAction = moduleAction(MODULE_ID, async (ctx, _form: FormData): Promise<void> => {
  const r = await hostInstall(ctx).requestInstall(
    DOCKER_PACKAGE,
    "so this module can show and control containers on this server",
  );
  await notice(
    ctx,
    r.ok ? "ok" : "warn",
    r.ok
      ? "Asked an administrator to install Docker Desktop. Approve it under this module's settings."
      : `Could not raise the request: ${r.reason}`,
  );
  revalidatePath(MODULE_PATH);
  revalidatePath(ADMIN_PATH);
});

/* ------------------------------------------------------------------ admin only */
// These reach host-install's admin surface, which refuses unless ctx.user is an ADMIN. The
// helper re-checks rather than trusting that this panel is only reachable by admins.

/**
 * **Raises a UAC prompt and runs the installer**, which takes minutes.
 * REFS addons/docker-manager/ui/settings-panel.tsx
 */
export const approveInstallAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  const outcome = await hostInstall(ctx).admin.approve(str(form, "id"));
  const say: Record<string, [("ok" | "warn" | "bad"), string]> = {
    done: ["ok", "Done. Docker may need a restart before it will start."],
    "cancelled-at-uac": ["warn", "You dismissed the Windows permission prompt, so nothing was installed."],
    expired: ["warn", "That request is no longer waiting."],
  };
  const [tone, text] = say[outcome.status] ?? [
    "bad",
    `It did not finish: ${outcome.status === "failed" ? outcome.detail : outcome.status}`,
  ];
  await notice(ctx, tone, text);
  revalidatePath(ADMIN_PATH);
  revalidatePath(MODULE_PATH);
});

/** REFS addons/docker-manager/ui/settings-panel.tsx */
export const declineInstallAction = moduleAction(MODULE_ID, async (ctx, form: FormData): Promise<void> => {
  await hostInstall(ctx).admin.decline(str(form, "id"));
  await notice(ctx, "ok", "Declined.");
  revalidatePath(ADMIN_PATH);
});

/**
 * Ask to remove Docker — only offered when JonDash installed it.
 *
 * Deliberately a request rather than an immediate removal: it goes through the same approve
 * step, so removing software is never one click from a settings page.
 * REFS addons/docker-manager/ui/settings-panel.tsx
 */
export const requestRemoveDockerAction = moduleAction(MODULE_ID, async (ctx, _form: FormData): Promise<void> => {
  const r = await hostInstall(ctx).requestUninstall(
    DOCKER_PACKAGE,
    "removing Docker Desktop, which JonDash installed",
  );
  await notice(
    ctx,
    r.ok ? "warn" : "bad",
    r.ok
      ? "Requested. Approve it below — containers and volumes are deleted with it."
      : `Could not raise the request: ${r.reason}`,
  );
  revalidatePath(ADMIN_PATH);
});
