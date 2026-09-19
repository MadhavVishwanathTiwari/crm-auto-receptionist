import { cn } from "@/lib/cn";

/**
 * Initials from an address. There are two operators and no profile pictures,
 * so this is a coloured monogram: enough to tell whose row it is at a glance.
 */
function initialsOf(value: string): string {
  const local = value.split("@")[0] ?? value;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

/** Stable per address, so the same person is the same colour on every screen. */
const HUES = [212, 258, 162, 28, 340, 186];

export function Avatar({
  email,
  size = "md",
  className,
}: {
  email: string;
  size?: "sm" | "md";
  className?: string;
}) {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) >>> 0;
  }
  const hue = HUES[hash % HUES.length]!;

  return (
    <span
      title={email}
      style={{
        backgroundColor: `oklch(0.38 0.07 ${hue})`,
        color: `oklch(0.9 0.06 ${hue})`,
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium select-none",
        size === "sm" ? "size-5 text-xs" : "size-6 text-xs",
        className,
      )}
    >
      {initialsOf(email)}
    </span>
  );
}
