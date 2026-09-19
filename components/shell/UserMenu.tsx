"use client";

import { Keyboard, LogOut, Settings2, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Kbd } from "@/components/ui/Kbd";
import { Dialog } from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import { createBrowserSupabase } from "@/lib/supabase/client";

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["Ctrl", "K"], what: "Open the command palette" },
  { keys: ["Ctrl", "Enter"], what: "Send the email you are writing" },
  { keys: ["Esc"], what: "Close a panel, a menu or a dialog" },
  { keys: ["/"], what: "Focus the search box on a list screen" },
];

/** Who you are signed in as, and the three things you do about it. */
export function UserMenu({
  email,
  role,
  collapsed,
}: {
  email: string | null;
  role: string;
  collapsed: boolean;
}) {
  const router = useRouter();
  const [shortcuts, setShortcuts] = useState(false);
  const address = email ?? "signed in";

  return (
    <>
      <DropdownMenu
        align="start"
        items={[
          { label: "Settings", icon: <Settings2 size={14} />, href: "/settings" },
          {
            label: "Keyboard shortcuts",
            icon: <Keyboard size={14} />,
            onSelect: () => setShortcuts(true),
          },
          {
            label: "Sign out",
            icon: <LogOut size={14} />,
            destructive: true,
            separated: true,
            onSelect: async () => {
              await createBrowserSupabase().auth.signOut();
              router.refresh();
              router.replace("/login");
            },
          },
        ]}
        trigger={({ ref, ...props }) => (
          <button
            ref={ref}
            type="button"
            {...props}
            title={address}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
              "text-left hover:bg-surface-2",
              collapsed && "justify-center px-0",
            )}
          >
            {email ? (
              <Avatar email={email} />
            ) : (
              <User size={14} className="text-ink-3" />
            )}
            {!collapsed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">
                  {address.split("@")[0]}
                </span>
                {role === "admin" && (
                  <span className="block text-xs text-ink-3">Admin</span>
                )}
              </span>
            )}
          </button>
        )}
      />

      <Dialog
        open={shortcuts}
        onClose={() => setShortcuts(false)}
        title="Keyboard shortcuts"
        description="This app is meant to be driven from the keyboard."
      >
        <ul className="divide-y divide-line">
          {SHORTCUTS.map((row) => (
            <li
              key={row.what}
              className="flex items-center justify-between gap-4 py-2"
            >
              <span className="text-ink-2">{row.what}</span>
              <span className="flex shrink-0 items-center gap-1">
                {row.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
