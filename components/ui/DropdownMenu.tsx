"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/cn";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  href?: string;
  destructive?: boolean;
  shortcut?: ReactNode;
  disabled?: boolean;
  /** Renders a hairline above this item. */
  separated?: boolean;
}

/**
 * A menu, with the keyboard behaviour a menu is supposed to have: arrows move,
 * Home/End jump, Escape closes without escaping any further (see
 * lib/ui/useEscape.ts), and focus returns to the trigger.
 */
export function DropdownMenu({
  trigger,
  items,
  align = "end",
  className,
}: {
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
    "aria-controls": string;
  }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[active]?.focus();
  }, [open, active]);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const enabled = items
    .map((item, index) => (item.disabled ? -1 : index))
    .filter((index) => index >= 0);

  function move(delta: number) {
    if (enabled.length === 0) return;
    const position = enabled.indexOf(active);
    const next =
      enabled[
        (position + delta + enabled.length * 2) % enabled.length
      ] ?? enabled[0]!;
    setActive(next);
  }

  return (
    <div className="relative">
      {trigger({
        ref: triggerRef,
        onClick: () => {
          setActive(enabled[0] ?? 0);
          setOpen((value) => !value);
        },
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": id,
      })}

      {open && (
        <div
          id={id}
          ref={menuRef}
          role="menu"
          aria-orientation="vertical"
          onKeyDown={(event) => {
            switch (event.key) {
              case "Escape":
                // Consumed here: nothing further out should also act on it.
                event.preventDefault();
                event.stopPropagation();
                close();
                break;
              case "ArrowDown":
                event.preventDefault();
                move(1);
                break;
              case "ArrowUp":
                event.preventDefault();
                move(-1);
                break;
              case "Home":
                event.preventDefault();
                setActive(enabled[0] ?? 0);
                break;
              case "End":
                event.preventDefault();
                setActive(enabled[enabled.length - 1] ?? 0);
                break;
              case "Tab":
                close(false);
                break;
            }
          }}
          className={cn(
            "absolute top-[calc(100%+4px)] z-40 min-w-[200px] overflow-hidden",
            "rounded-lg border border-line-2 bg-surface-3 py-1 shadow-lg",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
        >
          {items.map((item, index) => {
            const content = (
              <>
                {item.icon && (
                  <span className="shrink-0 text-ink-3">{item.icon}</span>
                )}
                <span className="flex-1 truncate text-left">{item.label}</span>
                {item.shortcut && (
                  <span className="shrink-0 text-ink-3">{item.shortcut}</span>
                )}
              </>
            );

            const classes = cn(
              "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left",
              "focus:outline-none focus-visible:outline-none",
              item.destructive ? "text-danger" : "text-ink-2",
              item.disabled
                ? "pointer-events-none opacity-40"
                : item.destructive
                  ? "hover:bg-danger-soft focus:bg-danger-soft"
                  : "hover:bg-surface-4 hover:text-ink focus:bg-surface-4 focus:text-ink",
              item.separated && "mt-1 border-t border-line pt-2.5",
            );

            const select = () => {
              close();
              item.onSelect?.();
            };

            return item.href ? (
              <a
                key={item.label}
                role="menuitem"
                href={item.href}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                tabIndex={-1}
                onClick={() => close(false)}
                className={classes}
              >
                {content}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                tabIndex={-1}
                disabled={item.disabled}
                onClick={select}
                className={classes}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
