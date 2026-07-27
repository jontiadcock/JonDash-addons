import type { Permission } from "@/lib/auth/permissions";
import type { Identity } from "./authorize";

/**
 * The tool registry.
 *
 * A tool declares what it needs *before* it can run, and the dispatcher enforces that — a tool
 * never checks its own permission. That is deliberate: a check inside a handler is one someone can
 * forget to write, and the failure is silent and total. Declared requirements are visible in one
 * table, and a tool with no `permission` is a decision someone can see rather than an omission.
 *
 * `kind` is not cosmetic. It is gate one: a read-only key cannot reach an `act` tool no matter what
 * its account may do. See `decide.ts`.
 */

export type ToolDef = {
  name: string;
  /** Shown to the model. It only ever sees this, the description and the schema — write for it. */
  description: string;
  kind: "read" | "act";
  /** The permission the BOUND ACCOUNT must hold. `null` = any valid key. */
  permission: Permission | null;
  /** JSON Schema for the arguments. Keep it tight; a loose schema is a prompt-injection surface. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>, identity: Identity) => Promise<unknown>;
};

const registry = new Map<string, ToolDef>();

export function register(tool: ToolDef): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

/**
 * The tools this identity may actually use.
 *
 * **Filtered by the bound account's real permissions**, so an agent is never shown a tool it cannot
 * call. That is better behaviour — a model offered a tool it will be refused wastes a turn and then
 * reports a failure to the operator — and it leaks nothing: the caller is already authenticated as
 * that account and could enumerate its own permissions anyway.
 *
 * An unauthenticated caller never reaches this. The transport refuses before the body is parsed, so
 * the tool list cannot be used to fingerprint an install.
 */
export function listFor(identity: Identity): ToolDef[] {
  return [...registry.values()].filter((t) => {
    if (t.kind === "act" && identity.mode !== "act") return false;
    if (t.permission && !identity.permissions.has(t.permission)) return false;
    return true;
  });
}

/** The wire shape a client sees. `run` and the internal fields never cross. */
export function toWire(t: ToolDef) {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

export function allTools(): ToolDef[] {
  return [...registry.values()];
}

/** Test seam only — the registry is module-global, so a test must be able to clear it. */
export function _reset(): void {
  registry.clear();
}
