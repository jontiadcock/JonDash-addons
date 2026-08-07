import type { ModulePageProps } from "@/lib/modules/types";
import mcp from "@/helpers/mcp/api";

/**
 * The page. Explains what the tile means, and — more usefully — what an assistant *cannot* do,
 * since that is the part nobody can infer from a status line.
 *
 * Display only. Every control lives on Admin → Addons → Shared capabilities; this page says so
 * rather than pretending it could offer them.
 * REFS addons/mcp-server/module.ts
 */
export default async function McpPage({ ctx }: ModulePageProps) {
  const s = await mcp(ctx).status();
  const muted = { color: "var(--muted)" } as const;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">AI assistant access</h1>
        <p className="text-sm" style={muted}>
          An assistant connects with a key you create, and can only do what the account behind that
          key can do.
        </p>
      </header>

      <section className="card flex flex-col gap-1 p-3">
        <span className="font-medium">
          {!s.enabled
            ? "Off — nothing is listening"
            : !s.listening
              ? "Switched on, but no port is open"
              : `Listening on ${s.exposed ? "your network" : "this machine only"}, port ${s.port}`}
        </span>
        <span className="text-sm" style={muted}>
          {s.keyCount} key{s.keyCount === 1 ? "" : "s"} · {s.toolCount} things an assistant can do ·{" "}
          {s.lastUsedAt ? `last used ${new Date(s.lastUsedAt).toLocaleString()}` : "never used"}
        </span>
        {s.exposed && (
          <span className="text-sm" style={{ color: "var(--danger)" }}>
            Reachable from your network. Anyone who can reach the port can try keys against it.
          </span>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">What an assistant cannot do</h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" style={muted}>
          <li>Sign out an administrator — that could lock you out of your own install.</li>
          <li>Read anyone&rsquo;s password, two-factor secret or recovery codes. Those are not readable through it at all.</li>
          <li>Install, update or remove anything.</li>
          <li>Run a command, or read a file.</li>
          <li>Give itself more access. A key can only ever do what its account can do.</li>
        </ul>
      </section>

      <p className="text-sm" style={muted}>
        Keys, what each one may do, and whether this is switched on are all managed under{" "}
        <strong>Admin &rarr; Addons &rarr; Shared capabilities</strong>. This page cannot change any
        of it &mdash; the module you are looking at has no power to grant an assistant anything.
      </p>
    </div>
  );
}
