"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/cn";
import {
  dismissToast,
  getServerToasts,
  getToasts,
  subscribeToasts,
  type ToastTone,
} from "@/lib/ui/toast";

const ICON: Record<ToastTone, typeof CircleCheck> = {
  ok: CircleCheck,
  danger: CircleAlert,
  warn: TriangleAlert,
  info: Info,
};

const TONE: Record<ToastTone, string> = {
  ok: "text-ok",
  danger: "text-danger",
  warn: "text-warn",
  info: "text-info",
};

/**
 * Where an action says what it did.
 *
 * Seven screens used to give no success feedback at all -- you inferred it from
 * a row disappearing on the next revalidation. Mounted in the root layout,
 * above ViewerZone: that keys its children by zone and remounts them on a first
 * visit, which would take any in-flight toast down with it.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(
    subscribeToasts,
    getToasts,
    getServerToasts,
  );

  return (
    <div
      // polite rather than assertive: these confirm work the operator just did,
      // they are not interruptions.
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[340px] flex-col gap-2"
    >
      {toasts.map((item) => {
        const Icon = ICON[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === "danger" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line-2",
              "bg-surface-3 px-3 py-2.5 text-lg shadow-lg",

            )}
            style={{
              animation:
                "toast-in var(--duration-base) var(--ease-out) both",
            }}
          >
            <Icon
              size={15}
              strokeWidth={2}
              aria-hidden="true"
              className={cn("mt-px shrink-0", TONE[item.tone])}
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{item.message}</p>
              {item.detail && (
                <p className="mt-0.5 text-ink-2">{item.detail}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(item.id)}
              aria-label="Dismiss"
              className="-mt-0.5 -mr-1 shrink-0 cursor-pointer rounded-sm p-1 text-ink-3 hover:bg-surface-4 hover:text-ink"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
