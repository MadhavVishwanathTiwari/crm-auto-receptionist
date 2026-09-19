import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Spinner } from "./Spinner";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "destructive"
  | "link";

export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  // Intent. The one place --color-accent is spent by default.
  primary:
    "bg-accent text-accent-ink shadow-sm hover:bg-accent-hover active:bg-accent",
  secondary:
    "border border-line-2 bg-surface-3 text-ink hover:border-line-strong hover:bg-surface-4",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  // Subtle destructive: the inline "remove" / "cancel it" case, which used to
  // be written BUTTON + " text-danger".
  danger:
    "border border-line-2 bg-surface-3 text-danger hover:border-danger hover:bg-danger-soft",
  // Solid destructive: the confirm button inside a dialog, and nowhere else.
  destructive: "bg-danger text-white shadow-sm hover:brightness-110",
  link: "text-accent underline-offset-2 hover:underline",
};

const SIZE: Record<ButtonSize, string> = {
  xs: "h-5 gap-1 rounded-sm px-1.5 text-xs",
  sm: "h-6 gap-1 rounded-sm px-2",
  md: "h-7 gap-1.5 rounded-md px-3",
  lg: "h-9 gap-2 rounded-md px-4 text-lg",
};

export interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the leading icon and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

/**
 * Class string for the times this has to be something other than a <button> --
 * a <Link>, or the <a> that starts the Google OAuth redirect on /mailboxes.
 */
export function buttonClasses(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap",
    "font-medium transition-colors duration-(--duration-fast)",
    "disabled:pointer-events-none disabled:opacity-40",
    VARIANT[variant],
    SIZE[size],
    variant === "link" && "h-auto px-0",
    className,
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconRight,
  fullWidth,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(
        variant,
        size,
        cn(fullWidth && "w-full", className),
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
      {iconRight}
    </button>
  );
}
