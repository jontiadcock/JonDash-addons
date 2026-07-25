import type { ModulePageProps } from "@/lib/modules/types";
import docker from "@/helpers/docker/api";
import hostInstall from "@/helpers/host-install/api";
import { STATE_LABEL, STATE_TONE, bytes, since, verbsFor, type ContainerState } from "./lib/constants";
import { noticeColour, readNotice } from "./lib/notice";
import { Setup } from "./ui/setup";
import { containerAction } from "./actions";

/**
 * The manager itself.
 *
 * Stats are fetched here and not in the widget: Docker computes CPU by sampling twice about a
 * second apart, so a `stats()` call costs roughly a second however many containers you ask
 * about. That is fine on a page someone opened; it is not fine on every dashboard render.
 */
export default async function DockerPage({ ctx }: ModulePageProps) {
  const api = docker(ctx);
  const [status, notice] = await Promise.all([api.status(), readNotice(ctx)]);

  if (!status.ok) {
    const support = await hostInstall(ctx).capability();
    return (
      <div className="flex flex-col gap-4">
        <Header />
        {notice && <Notice tone={notice.tone} text={notice.text} />}
        <Setup status={status} canInstall={support.ok} />
      </div>
    );
  }

  const containers = await api.list();
  const running = containers.filter((c) => c.state === "running");
  const stats = running.length > 0 ? await api.stats(running.map((c) => c.id)) : {};

  return (
    <div className="flex flex-col gap-4">
      <Header />
      {notice && <Notice tone={notice.tone} text={notice.text} />}

      <p className="text-sm" style={{ color: "var(--muted)" }}>
        Docker {status.version} · {containers.length} container{containers.length === 1 ? "" : "s"},{" "}
        {running.length} running
      </p>

      {containers.length === 0 ? (
        <p className="card p-4 text-sm" style={{ color: "var(--muted)" }}>
          No containers yet. Start one with <code>docker run</code> or Compose and it will appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {containers.map((c) => {
            const state = c.state as ContainerState;
            const s = stats[c.id];
            return (
              <li key={c.id} className="card flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{c.name}</span>
                    {c.health !== "none" && (
                      <span
                        className="text-xs"
                        style={{ color: c.health === "healthy" ? "var(--success, inherit)" : "var(--danger)" }}
                      >
                        {c.health}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs" style={{ color: "var(--muted)" }}>
                    {c.image}
                    {c.project && ` · ${c.project}/${c.service}`}
                    {c.ports.length > 0 &&
                      ` · ${c.ports
                        .filter((p) => p.public !== null)
                        .map((p) => `${p.public}→${p.private}`)
                        .join(" ")}`}
                  </span>
                </span>

                <span className="flex flex-col items-end text-xs" style={{ color: "var(--muted)" }}>
                  <span style={{ color: STATE_TONE[state] }}>{STATE_LABEL[state]}</span>
                  {/* The engine's own phrasing — "Up 3 days" — beats anything recomputed. */}
                  <span>{c.status || since(c.createdAt)}</span>
                </span>

                {s && (
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    {s.cpuPct}% CPU · {bytes(s.memoryBytes)}
                  </span>
                )}

                <span className="flex flex-wrap gap-1">
                  {verbsFor(state).map((verb) => (
                    <form key={verb} action={containerAction}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="verb" value={verb} />
                      <input type="hidden" name="name" value={c.name} />
                      <button type="submit" className="btn btn-sm" style={{ textTransform: "capitalize" }}>
                        {verb}
                      </button>
                    </form>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-lg font-medium">Docker</h1>
      <p className="text-sm" style={{ color: "var(--muted)" }}>
        Containers on this server. JonDash can start, stop, pause and restart them — it cannot run
        commands inside one, create or delete one, or touch images and volumes.
      </p>
    </header>
  );
}

function Notice({ tone, text }: { tone: "ok" | "warn" | "bad"; text: string }) {
  return (
    <p className="card p-3 text-sm" style={{ color: noticeColour(tone) }}>
      {text}
    </p>
  );
}
