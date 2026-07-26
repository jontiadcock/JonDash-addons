# Inherited from the JonDash-mcp repo

Rescued 2026-07-26, the day the MCP session was deleted and its repo archived and removed. Both
files below were the **canonical copies** of their subject and existed nowhere else — the memory
corpus held only summaries that pointed here.

Kept verbatim. **Read them for the design thinking, not as current fact.**

| File | What it is | What is no longer true |
| ---- | ---------- | ---------------------- |
| `API-CONTRACT.md` | The scoped-token + `/api/v1` spec asked of core (SEC-06) | **Core is not building it.** MCP is a helper now, running in-process, so there is no boundary to authenticate across. §1–6 describe an API that will not exist. |
| `TOOL-CATALOGUE.md` | The MCP server's README — the tool list, scopes and conventions | The env-var config and stdio transport do not apply to a helper. The **tools and their scope mapping do**, and they are what `../HELPER.md` is built from. |

## Why these two were worth keeping

**`API-CONTRACT.md` §7 — module-contributed tools.** The owner's words: *"a MUST, not a maybe"*. A
module an assistant cannot see is a module it cannot help with, and the answer is **discovery**
(`GET /tools` → dynamic registration), never a hardcoded per-module list requiring a release. That
requirement outlives the transport it was written for, and §7 is the only full specification of it.

**The rest of `API-CONTRACT.md`** is a careful spec for a real remote API. If JonDash ever wants one
for something other than MCP, start here rather than from nothing.

**`TOOL-CATALOGUE.md`** is where the tool names, their required scopes, and the error conventions
were settled. The helper reuses them unchanged so an agent written against the old design still
recognises the tools.
