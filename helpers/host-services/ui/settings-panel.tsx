import type { HelperSettingsContext } from "@/lib/helpers/types";
import { listEntries } from "../lib/allowlist";
import { openSuggestions, pendingRequests } from "../lib/requests";
import { readStates } from "../lib/services";
import { capability } from "../lib/grant";
import PanelClient from "./panel-client";

/**
 * The allowlist editor, on JonDash's own page.
 *
 * **A SERVER component that loads, wrapping a client component that renders.** Core calls
 * `<SettingsPanel ctx={{ helperId, user }} />` and passes nothing else — so a client component
 * has no route to the data at all: it cannot reach the database, and there is no prop carrying
 * the list. The first version was a single client component reading a `data` prop that nothing
 * supplied, so it showed "Nothing approved yet" however many services were approved. It
 * typechecked, because the prop was optional.
 *
 * **This is where the editor belongs.** It lived in a consuming module's settings panel until
 * 2026-07-26, which meant the module supplied the service name being approved — it could
 * display "Add Plex" and submit `sshd`, and the UAC prompt names the binary rather than the
 * service. The thing being bounded could edit its own boundary. Now core renders this behind
 * `modules.manage`, `onSettingsSubmit` receives a `ctx.user` resolved from the session, and no
 * module is anywhere in the path.
 */
export default async function HostServicesSettings({ ctx }: { ctx: HelperSettingsContext }) {
  const [entries, pending, suggestions] = await Promise.all([
    listEntries(),
    pendingRequests(),
    openSuggestions(),
  ]);
  const states = await readStates(entries.map((e) => e.serviceName));
  const support = capability();

  return (
    <PanelClient
      helperId={ctx.helperId}
      entries={entries.map((e) => ({
        id: e.id,
        name: e.serviceName,
        label: e.label,
        state: states.get(e.serviceName) ?? "unknown",
        canControl: e.canControl,
        unattended: e.unattended,
        taskBase: e.taskBase,
      }))}
      pending={pending.map((p) => ({
        id: p.id,
        moduleId: p.moduleId,
        serviceLabel: entries.find((e) => e.id === p.entryId)?.label ?? "(removed)",
        action: p.action,
      }))}
      suggestions={suggestions.map((s) => ({
        id: s.id,
        moduleId: s.moduleId,
        serviceName: s.serviceName,
        reason: s.reason,
      }))}
      support={support.ok ? { ok: true } : { ok: false, reason: support.reason }}
    />
  );
}
