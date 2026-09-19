import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, letting a caller's utility win over a component's default.
 *
 * Tailwind utilities for the same property have equal specificity, so which one
 * applies is decided by the order the rules land in the stylesheet rather than
 * the order they are written at the call site. That is why the old string
 * constants could not be overridden -- `BUTTON + " px-6"` was a coin flip, and
 * Charts.tsx carries a comment about the same hazard biting a colour class.
 * twMerge resolves the conflict by dropping the losing class outright.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
