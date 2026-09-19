import { cn } from "@/lib/cn";

/**
 * The five hand-written <table>s in this app all agreed on the same recipe and
 * repeated `py-1 font-normal` nineteen times between them. This is that recipe,
 * named.
 */
export function Table({
  className,
  children,
  ...rest
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cn("w-full border-collapse", className)} {...rest}>
      {children}
    </table>
  );
}

export function THead({ children }: { children: React.ReactNode }) {
  return (
    <thead className="text-left text-ink-3">
      <tr className="border-b border-line">{children}</tr>
    </thead>
  );
}

export function TH({
  className,
  align,
  children,
  ...rest
}: React.ThHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "px-2 py-1.5 text-xs font-medium tracking-wide uppercase",
        align === "right" && "text-right",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TR({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-line last:border-0 hover:bg-surface-2",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function TD({
  className,
  align,
  children,
  ...rest
}: React.TdHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right";
}) {
  return (
    <td
      className={cn("px-2 py-1.5", align === "right" && "text-right", className)}
      {...rest}
    >
      {children}
    </td>
  );
}
