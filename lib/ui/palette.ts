/**
 * Opening the command palette from somewhere that is not the keyboard.
 *
 * A module-level signal rather than context, for the same reason the toast
 * store is one: the sidebar's search button and the palette are siblings, and
 * threading a callback between them through the server layout that renders
 * both would mean making that layout a client component.
 */
const listeners = new Set<() => void>();

export function onOpenPalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openCommandPalette(): void {
  for (const listener of listeners) listener();
}
