"use client";

import { useActionState } from "react";
import type { ActionResult } from "../lib/types";

/**
 * The one piece of client-side code in the module.
 *
 * A plain `<form action={serverAction}>` works without any JavaScript, but it can't tell
 * you what happened — and "did that save?" is exactly the question someone has after
 * pressing a button. This wrapper keeps the server action but shows its answer, disables
 * the button while it runs, and can ask before doing something destructive.
 *
 * It imports only the ActionResult type, which is why it doesn't drag any server code
 * into the browser bundle.
 */

type Props = {
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  children?: React.ReactNode;
  /** Ask this before submitting. Use for anything that deletes. */
  confirm?: string;
  variant?: "primary" | "ghost" | "danger";
  /** Lay the fields out in a row instead of a column. */
  inline?: boolean;
  className?: string;
};

export function ActionForm({
  action,
  submitLabel,
  children,
  confirm,
  variant = "primary",
  inline = false,
  className = "",
}: Props) {
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_previous, formData) => action(formData),
    null,
  );

  return (
    <form
      action={formAction}
      className={`${inline ? "flex flex-wrap items-end gap-2" : "flex flex-col gap-3"} ${className}`}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <div className={inline ? "" : "flex items-center gap-3"}>
        <button className={`btn btn-${variant}`} type="submit" disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </button>
        {result && !inline ? (
          <span
            className="text-sm"
            style={{ color: result.ok ? "var(--muted)" : "var(--danger)" }}
            role="status"
          >
            {result.message}
          </span>
        ) : null}
      </div>
      {result && inline ? (
        <p
          className="w-full text-sm"
          style={{ color: result.ok ? "var(--muted)" : "var(--danger)" }}
          role="status"
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}

/** A labelled field. Keeps every form in the module laid out the same way. */
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {help ? (
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {help}
        </span>
      ) : null}
    </label>
  );
}
