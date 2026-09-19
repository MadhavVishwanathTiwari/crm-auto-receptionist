/**
 * Transient confirmation, as a module-level store.
 *
 * Deliberately not a context provider. ViewerZone keys its children by zone and
 * remounts them when the browser's timezone turns out to disagree with the
 * cookie, and a provider inside that would take an in-flight toast down with
 * it. A module store outlives every remount.
 */

export type ToastTone = "ok" | "danger" | "warn" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  /** A second line: the server's sentence, when there is one worth reading. */
  detail?: string;
  duration: number;
}

const DEFAULT_DURATION = 4000;
/** An error stays until it is dismissed or replaced; you have to be able to read it. */
const ERROR_DURATION = 9000;

let nextId = 1;
let current: Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** Stable empty array: useSyncExternalStore compares snapshots by identity. */
const EMPTY: Toast[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): Toast[] {
  return current;
}

export function getServerToasts(): Toast[] {
  return EMPTY;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  const next = current.filter((item) => item.id !== id);
  if (next.length === current.length) return;
  current = next.length === 0 ? EMPTY : next;
  emit();
}

function push(tone: ToastTone, message: string, detail?: string): number {
  const id = nextId++;
  const duration = tone === "danger" ? ERROR_DURATION : DEFAULT_DURATION;
  // Newest first, and never more than four on screen at once.
  current = [{ id, tone, message, detail, duration }, ...current].slice(0, 4);
  emit();

  if (typeof window !== "undefined") {
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    );
  }
  return id;
}

export const toast = {
  success: (message: string, detail?: string) => push("ok", message, detail),
  error: (message: string, detail?: string) => push("danger", message, detail),
  warn: (message: string, detail?: string) => push("warn", message, detail),
  info: (message: string, detail?: string) => push("info", message, detail),
  dismiss: dismissToast,
};
