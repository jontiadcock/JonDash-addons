import type { HelperSettingsContext } from "@/lib/helpers/types";
import { listEntries } from "../lib/allowlist";
import { openSuggestions, pendingRequests } from "../lib/requests";
import { readStates } from "../lib/services";
import { capability } from "../lib/grant";
import PanelClient from "./panel-client";

/**
 * The allowlist editor, on JonDash's own page.
 *
 * ⚠ A SERVER component wrapping a client component that renders. Core passes only
 * `ctx={{ helperId, user }}`, so a client alone has no route to the data — a prior version read
 * an optional `data` prop nothing supplied, typechecked, and silently showed "Nothing approved
 * yet" regardless of how many services existed.
 *
 * This is where the editor belongs, not in a consuming module's settings panel — see
 * `helper.ts`'s "no third capability" for why. Core renders this behind `modules.manage`.
 * REFS helpers/host-services/helper.ts
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
