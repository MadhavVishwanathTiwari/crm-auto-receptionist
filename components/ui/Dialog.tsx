"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./Button";

const SIZE = {
  sm: "max-w-[380px]",
  md: "max-w-[520px]",
  lg: "max-w-[720px]",
} as const;

/**
 * A modal, on the platform's own <dialog>.
 *
 * showModal() brings the focus trap, the inert background, the top layer and
 * Escape with it, which is most of what a hand-rolled modal gets wrong. What it
 * does not bring is a controlled `open` prop, so the effect below reconciles
 * one, and the Escape bookkeeping described in lib/ui/useEscape.ts.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  size = "md",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZE;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // The platform closes on Escape by itself. We take it over so `open`
      // stays the single source of truth, then mark the event consumed so the
      // drawer listening on window behind this does not also navigate away.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      // A click on the backdrop targets the dialog element itself.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      aria-labelledby="dialog-title"
      className={cn(
        "m-auto w-[calc(100vw-4rem)] rounded-xl border border-line-2 bg-surface p-0",
        "text-ink shadow-xl backdrop:bg-overlay",
        SIZE[size],
      )}
    >
      <div className="flex items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="dialog-title" className="text-lg font-semibold text-ink">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-ink-2">{description}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close"
          icon={<X size={14} />}
          className="-mt-0.5 -mr-1.5"
        />
      </div>

      {children && <div className="px-4 py-3 text-lg">{children}</div>}

      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}
