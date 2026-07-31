import type { EngineStatus } from "@/helpers/docker/api";
import { DOCKER_PACKAGE } from "../lib/constants";
import { requestDockerAction } from "../actions";

/**
 * What to show when there is no working engine.
 *
 * This is the part of the module that earns its keep before Docker exists. Each state has a
 * *different fix*, and lumping them into "Docker isn't available" is what leaves people
 * guessing — particularly the third, which is the one nobody diagnoses on their own.
 * REFS addons/docker-manager/page.tsx
 */
export function Setup({ status, canInstall }: { status: Extract<EngineStatus, { ok: false }>; canInstall: boolean }) {
  if (status.reason === "no-access") {
    return (
      <div className="card flex flex-col gap-2 p-4">
        <p className="font-medium">Docker is running, but JonDash can&apos;t talk to it</p>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          The account JonDash runs as needs to be in the <strong>docker-users</strong> group. Add it, then
          sign out and back in — group membership only applies to new sessions.
        </p>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Socket: <code>{status.socket}</code>
        </p>
      </div>
    );
  }

  if (status.reason === "timeout" || status.reason === "failed") {
    return (
      <div className="card flex flex-col gap-2 p-4">
        <p className="font-medium">Docker didn&apos;t answer</p>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {status.detail} It may still be starting up.
        </p>
      </div>
    );
  }

  // not-running: either not installed at all, or installed and stopped. We cannot tell the
  // two apart from the socket alone, so the page offers both without guessing.
  return (
    <div className="card flex flex-col gap-3 p-4">
      <p className="font-medium">Docker isn&apos;t running on this server</p>
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        If Docker Desktop is installed, start it and this page will fill in. If it isn&apos;t, you can
        install it below or from a terminal.
      </p>

      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Install it yourself</p>
        <pre className="overflow-x-auto rounded p-2 text-xs" style={{ background: "var(--surface-2)" }}>
          winget install {DOCKER_PACKAGE}
        </pre>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Needs WSL2 and a restart afterwards. On Windows Home, enable WSL2 first with{" "}
          <code>wsl --install</code>.
        </p>
      </div>

      {canInstall && (
        <form action={requestDockerAction} className="flex flex-col gap-1">
          {/* Deliberately worded as a request, because that is what it is: this writes a row.
              An administrator approves it, sees the package name, and Windows asks again. */}
          <button type="submit" className="btn btn-sm" style={{ alignSelf: "flex-start" }}>
            Ask an administrator to install it
          </button>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Installs <code>{DOCKER_PACKAGE}</code>. Nothing happens until an administrator approves it.
          </p>
        </form>
      )}

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Looking for the engine at <code>{status.socket}</code>.
      </p>
    </div>
  );
}
