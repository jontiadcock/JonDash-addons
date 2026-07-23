import type { Run } from "../lib/store";
import { HEALTH_TONE, formatBytes, formatRelative } from "../lib/constants";

/**
 * Recent runs, drawn as bars — sized by how much was copied, coloured by outcome.
 *
 * Not decoration. The two things a backup owner needs to spot are both shapes rather than
 * numbers: a run of failures, and a sudden collapse in how much was copied. The second is
 * the dangerous one, because it looks like success — a backup that copies 4 MB instead of
 * the usual 4 GB has almost certainly lost its source, and every individual run still says
 * "done". A column chart makes that obvious at a glance; a table of numbers does not.
 *
 * Plain divs, no charting library. A module may not add dependencies, and anything fancier
 * would be a client bundle for something that is fundamentally twenty rectangles.
 */

const muted = { color: "var(--muted)" } as const;

function toneOf(run: Run): string {
  if (run.state === "running") return HEALTH_TONE.running;
  if (run.state === "cancelled") return HEALTH_TONE.idle;
  if (run.state !== "done") return HEALTH_TONE.bad;
  return run.errorCount > 0 ? HEALTH_TONE.warn : HEALTH_TONE.ok;
}

/**
 * Is the most recent successful run suspiciously small next to what came before?
 *
 * Deliberately conservative — a tenth of the median of the previous successes, and only
 * once there are enough of them to have a median worth trusting. A backup legitimately
 * shrinks when someone clears out a folder, so this is worded as a question, not a verdict.
 */
function suspiciouslySmall(runs: Run[]): { latest: number; typical: number } | null {
  const done = runs.filter((r) => r.state === "done");
  if (done.length < 4) return null;

  const [latest, ...rest] = done; // runs arrive newest-first
  if (latest.bytesCopied === 0) return null; // nothing to copy is normal for `sync`

  const sizes = rest.map((r) => r.bytesCopied).filter((b) => b > 0).sort((a, b) => a - b);
  if (sizes.length < 3) return null;

  const typical = sizes[Math.floor(sizes.length / 2)];
  return latest.bytesCopied * 10 < typical ? { latest: latest.bytesCopied, typical } : null;
}

export default function Activity({ runs }: { runs: Run[] }) {
  const recent = runs.slice(0, 20);
  if (recent.length === 0) return null;

  const peak = Math.max(...recent.map((r) => r.bytesCopied), 1);
  const warning = suspiciouslySmall(recent);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium">Recent activity</h2>

      {/* Oldest on the left, so it reads left-to-right like time does. */}
      <div className="flex items-end gap-1" style={{ height: 64 }}>
        {[...recent].reverse().map((r) => {
          // A floor of 2px so a zero-byte run is still a visible tick rather than a gap —
          // "it ran and copied nothing" and "it didn't run" must not look the same.
          const height = Math.max(2, Math.round((r.bytesCopied / peak) * 60));
          return (
            <div
              key={r.id}
              title={`${formatRelative(r.startedAt)} — ${r.state}, ${r.filesCopied} file(s), ${formatBytes(r.bytesCopied)}`}
              style={{
                width: 10,
                height,
                background: toneOf(r),
                opacity: r.state === "done" ? 1 : 0.85,
                borderRadius: 2,
              }}
            />
          );
        })}
      </div>

      <p className="text-xs" style={muted}>
        Last {recent.length} run{recent.length === 1 ? "" : "s"}, oldest first. Height is how much
        was copied; colour is the outcome. Hover for detail.
      </p>

      {warning && (
        <p className="text-sm" style={{ color: "var(--warning, var(--danger))" }}>
          The most recent backup copied {formatBytes(warning.latest)}, where this job usually copies
          around {formatBytes(warning.typical)}. That is normal if you have deleted a lot from the
          source — but it is also what a source that has gone missing looks like, so it is worth a
          glance.
        </p>
      )}
    </section>
  );
}
