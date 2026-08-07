"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The only client-side code in this module: refreshes the server-rendered page on a timer
 * while a backup is running, so a long copy doesn't sit showing a frozen "Running now" while
 * the helper publishes live progress nobody's watching. Mount only when something is in
 * flight — an idle page should do no polling at all.
 *
 * ⚠ Holds no state, renders nothing, and imports nothing from the module's data layer,
 * deliberately: anything server-side pulled in here would bundle for the browser.
 * REFS addons/backup-manager/page.tsx · addons/backup-manager/ui/job-detail.tsx ·
 *      addons/backup-manager/ui/widget.tsx
 */
export default function LiveRefresh({ everyMs = 3000 }: { everyMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    // Guard against a caller passing something silly; a 50ms poll would hammer the server.
    const period = Math.max(1000, everyMs);
    const timer = setInterval(() => router.refresh(), period);
    return () => clearInterval(timer);
  }, [router, everyMs]);

  return null;
}
