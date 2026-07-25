import type { ModuleSettingsPanelProps } from "@/lib/modules/types";
import hostInstall from "@/helpers/host-install/api";
import docker from "@/helpers/docker/api";
import { DOCKER_PACKAGE } from "../lib/constants";
import { noticeColour, readNotice } from "../lib/notice";
import { approveInstallAction, declineInstallAction, requestRemoveDockerAction } from "../actions";

/**
 * Approving installs, and removing Docker again.
 *
 * **The Remove Docker button is here as a stopgap and the wrong place for it.** The moment
 * someone thinks about removing Docker is the moment they remove this module — so it belongs
 * on the uninstall confirmation, which cannot ask questions yet. Core has confirmed the shape
 * (`uninstallQuestions`) but not scheduled it; when it lands this moves there.
 */
export default async function DockerSettings({ ctx }: ModuleSettingsPanelProps) {
  const hi = hostInstall(ctx);
  const [pending, installedByUs, support, status, notice] = await Promise.all([
    hi.admin.pending(),
    hi.admin.installedByUs(),
    hi.capability(),
    docker(ctx).status(),
    readNotice(ctx),
  ]);

  const weInstalledDocker = installedByUs.some((p) => p.packageId.toLowerCase() === DOCKER_PACKAGE.toLowerCase());

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <p className="card p-3 text-sm" style={{ color: noticeColour(notice.tone) }}>
          {notice.text}
        </p>
      )}

      {!support.ok && (
        <p className="card p-3 text-sm" style={{ color: "var(--muted)" }}>
          {support.message}
        </p>
      )}

      {pending.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Waiting for you</h3>
          {pending.map((p) => (
            <div key={p.id} className="card flex flex-col gap-2 p-3">
              {/* The package id, verbatim. UAC names our binary and says nothing about what is
                  being installed, so this line is the only place the admin can actually see
                  what they are agreeing to. */}
              <p className="text-sm">
                <strong style={{ textTransform: "capitalize" }}>{p.action}</strong>{" "}
                <code>{p.packageId}</code>
              </p>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Asked by <code>{p.moduleId}</code> — {p.reason}
              </p>
              <p className="text-xs" style={{ color: "var(--warning, var(--muted))" }}>
                Windows will ask your permission. The installer runs as administrator and can take
                several minutes.
              </p>
              <span className="flex gap-1">
                <form action={approveInstallAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className="btn btn-sm">
                    Approve and run
                  </button>
                </form>
                <form action={declineInstallAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <button type="submit" className="btn btn-sm">
                    Decline
                  </button>
                </form>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">Docker</h3>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {status.ok
            ? `Engine ${status.version} is running at ${status.socket}.`
            : "The engine is not reachable from JonDash."}
        </p>

        {weInstalledDocker ? (
          <form action={requestRemoveDockerAction} className="flex flex-col gap-1">
            <button type="submit" className="btn btn-sm" style={{ alignSelf: "flex-start" }}>
              Remove Docker Desktop
            </button>
            <p className="text-xs" style={{ color: "var(--warning, var(--muted))" }}>
              JonDash installed this, so it can remove it. <strong>Containers and volumes go with
              it.</strong> You will be asked to approve, and Windows will ask again.
            </p>
          </form>
        ) : (
          // The other half of "clean up what you created, never what you found". If the admin
          // installed Docker themselves, it is not ours to offer to remove.
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            JonDash did not install Docker, so it will not offer to remove it. Uninstall it the way you
            installed it.
          </p>
        )}
      </section>

      {installedByUs.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">Installed by JonDash</h3>
          {installedByUs.map((p) => (
            <p key={p.packageId} className="text-xs" style={{ color: "var(--muted)" }}>
              <code>{p.packageId}</code> — for <code>{p.forModule ?? "?"}</code>, {p.installedAt.slice(0, 10)}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
