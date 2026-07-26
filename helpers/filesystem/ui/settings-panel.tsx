import type { HelperSettingsContext } from "@/lib/helpers/types";
import { listRoots, openSuggestions, readRetention } from "../lib/admin";
import PanelClient from "./panel-client";

/**
 * The approved-folder editor, on JonDash's own page.
 *
 * **A SERVER component that loads, wrapping a client component that renders.** Core calls
 * `<SettingsPanel ctx={{ helperId, user }} />` and passes nothing else, so a client component
 * would have no route to this data at all — it cannot reach the database and there is no prop
 * carrying it. `host-services` shipped that mistake in 0.0.2 and the page showed an empty list
 * however many folders were approved.
 *
 * Deliberately plain, because it is INTERIM. CORE-10 moves permission editing to a generic
 * Admin → Permissions screen that core renders from a declared shape, at which point this file
 * is deleted and the logic in `lib/admin.ts` is driven from there instead. Everything that
 * matters lives in that module, not in this markup — so the replacement costs a UI, not a
 * rewrite. Nothing here is worth polishing.
 */
export default async function FilesystemSettings({ ctx }: { ctx: HelperSettingsContext }) {
  const [roots, suggestions, retention] = await Promise.all([
    listRoots(),
    openSuggestions(),
    readRetention(),
  ]);

  return (
    <PanelClient
      helperId={ctx.helperId}
      roots={roots.map((r) => ({
        id: r.id,
        path: r.path,
        label: r.label,
        riskLevel: r.riskLevel,
        riskNote: r.riskNote,
      }))}
      suggestions={suggestions}
      retention={retention}
    />
  );
}
