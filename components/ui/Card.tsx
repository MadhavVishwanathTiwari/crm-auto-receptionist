import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** The app's surface. Replaces the PANEL class string, 63 uses of it. */
export function Card({
  className,
  children,
  elevated,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { elevated?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-surface",
        elevated && "shadow-md",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-line px-4 py-2.5",
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0 text-ink-3">{icon}</span>}
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-medium text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-ink-3">{subtitle}</p>}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

export function CardFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-line px-4 py-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}
