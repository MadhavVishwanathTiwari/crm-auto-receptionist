import { cn } from "@/lib/cn";

const CONTROL =
  "rounded-md border border-line bg-surface-2 px-2.5 text-ink " +
  "transition-colors duration-(--duration-fast) " +
  "placeholder:text-ink-3 " +
  "hover:border-line-2 " +
  "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft " +
  "aria-invalid:border-danger " +
  "disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The control recipe as a string, for the places still writing raw elements.
 * Width is deliberately not in it: the components below add w-full, and a
 * caller concatenating a width onto the bare string would otherwise be
 * fighting an equal-specificity w-full.
 */
export function inputClasses(className?: string): string {
  return cn(CONTROL, "h-7", className);
}

export function Input({
  className,
  ...rest
}: React.ComponentPropsWithRef<"input">) {
  return <input className={cn(CONTROL, "h-7 w-full", className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: React.ComponentPropsWithRef<"textarea">) {
  return (
    <textarea
      className={cn(CONTROL, "w-full resize-y py-1.5", className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: React.ComponentPropsWithRef<"select">) {
  return (
    <select
      className={cn(
        CONTROL,
        "h-7 w-full cursor-pointer appearance-none bg-no-repeat pr-7",
        // The caret, as a data URI so it themes with --color-ink-3 and costs
        // no request. appearance-none removes the platform one.
        "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20fill%3D%22none%22%20stroke%3D%22%236b7280%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%3E%3Cpath%20d%3D%22m3%204.5%203%203%203-3%22%2F%3E%3C%2Fsvg%3E')]",
        "bg-[position:right_0.5rem_center]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Checkbox({
  className,
  ...rest
}: React.ComponentPropsWithRef<"input">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-3.5 shrink-0 cursor-pointer rounded-sm border border-line-2 bg-surface-2",
        "accent-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}
