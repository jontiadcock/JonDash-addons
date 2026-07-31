import type { HelperSettingsContext } from "@/lib/helpers/types";
import { listRoots, openSuggestions, readRetention } from "../lib/admin";
import PanelClient from "./panel-client";

/**
 * The approved-folder editor, on JonDash's own page. ⚠ A SERVER component wrapping a
 * client component that renders — core calls `<SettingsPanel ctx={{ helperId, user }} />`
 * with nothing else, so a client component would have no route to this data at all
 * (`host-services` shipped exactly that mistake once: an empty list however many folders
 * were approved).
 *
 * Deliberately plain and INTERIM: CORE-10 moves this to a generic Admin → Permissions
 * screen core renders from a declared shape, at which point `lib/admin.ts` drives that
 * screen instead and this file is deleted — the replacement costs a UI, not a rewrite.
 * REFS helpers/filesystem/helper.ts
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
