"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The only client-side code in this module: refresh the server-rendered page while a
 * backup is actually running.
 *
 * Everything here is server components and plain forms, which is the right default — no
 * state to fall out of step with the database. But a backup that takes ten minutes and
 * shows a frozen "Running now" until you press F5 reads as broken, and the helper has been
 * publishing live progress the whole time with nobody watching it.
 *
 * So this asks Next to re-render the server component on a timer. It holds no state of its
 * own and renders nothing — the numbers still come from the server, which is what keeps
 * them honest. Mount it only when something is in flight, so an idle page does no polling
 * at all.
 *
 * It imports nothing from the module's data layer, deliberately. Anything server-side
 * pulled in here would be bundled for the browser.
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
