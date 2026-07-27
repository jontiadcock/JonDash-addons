# Bugs — JonDash add-ons

Defects in the add-ons and helpers published from this repository. Bugs in **JonDash itself** belong
in the app's own list, not here.

**IDs are `AB-##`, stable and never reused** — a fixed bug keeps its number forever so a reference
in a commit, a doc or a release note always resolves. Fixed entries stay, at the bottom.

Features and planned work live in [`ROADMAP.md`](ROADMAP.md) (`AM-##` / `AH-##`). A bug is something
that does not do what it says; a roadmap item is something that does not exist yet. They never
share a list, because a bug list you have to filter is one nobody reads.

---

## Open

*(none)*

---

## Fixed

### AB-01 — changing the MCP port left the old port listening ✅ fixed in `mcp 0.0.3-beta.1`

**Reported by the owner, 2026-07-27. Reproduced before fixing.**

Changing the port on the AI-assistant settings page opened the new port and **left the old one
bound**. Both listened at once, on the same process:

```
TCP    127.0.0.1:3030    LISTENING    28784      <- should have closed
TCP    127.0.0.1:3031    LISTENING    28784
```

**Cause: the listener lived in a module-level variable, and Next loads the module twice.**

`transport.ts` held `let server` at module scope. The copy `instrumentation.ts` uses at boot is
**not** the copy a server action gets, so when `onSettingsSubmit` ran the port change it was looking
at a second instance whose `server` was still `null`. `stopListener()` saw nothing to close and
returned immediately; `startListener()` then bound the new port in that instance. Two live
listeners, neither instance aware of the other, and the old one still serving.

> **My first diagnosis was wrong, and it is recorded rather than quietly replaced.** I blamed
> `server.close()` waiting on held keep-alive connections — plausible, and a real weakness — built a
> reproduction that held a socket open, and "confirmed" it. The fix for that changed nothing,
> because the close was never reached at all. What settled it was the test I should have run first:
> **change the port with nothing connected.** It reproduced identically, which ruled out keep-alive
> in one step. A reproduction that only exercises the suspected cause will confirm it whether or not
> it is true.

**Impact.** The endpoint stayed reachable on a port an administrator believed they had moved away
from, until the next restart. Worse when the port is changed *to get off* an exposed one, since
that is precisely when leaving the old one open matters. `isListening()` was unreliable for the same
reason — the settings page could be reading a different instance than the one holding the socket.

**Fix.** The listener is held on `globalThis` behind a `Symbol.for` key, so every module instance
shares one handle and "is there a listener?" has one answer. Kept from the first attempt, because
both are correct hardening once the close is actually reached: `closeAllConnections()` ends held
sockets instead of waiting on them, and the close is bounded by a timeout so a stuck socket cannot
leave `stopListener` hanging. See `helpers/mcp/lib/transport.ts`.

**Test.** `WORKING/test-scripts/mcp/port-change-test.mjs` — changes the port and asserts the old one
is closed and the new one serving. It holds a keep-alive connection while doing it, which is no
longer the trigger but is the harder case and worth keeping.
