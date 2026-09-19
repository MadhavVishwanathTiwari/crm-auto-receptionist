"use client";

import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "@/lib/cn";

/**
 * A labelled control. Wires the label, the hint and the error message to the
 * input by id, which the hand-written <label><span>caption</span> pairs the app
 * used before could not do for the error text.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: (ids: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": true | undefined;
  }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("space-y-1", className)}>
      {label && (
        <label htmlFor={id} className="block text-ink-2">
          {label}
          {required && (
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
          )}
        </label>
      )}
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-xs text-ink-3">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
