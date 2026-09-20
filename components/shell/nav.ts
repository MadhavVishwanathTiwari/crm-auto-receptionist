import {
  Ban,
  Bell,
  BookOpen,
  CalendarClock,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  Mailbox,
  PenLine,
  SquareKanban,
  Target,
  Upload,
  Settings2,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Route } from "next";

/**
 * The fifteen screens, grouped.
 *
 * Ordering is the pipeline's, not the alphabet's, and that is a decision worth
 * carrying forward rather than losing to a component: Write is first because it
 * is the job, and an operator who opens this app to send today's forty should
 * land on the screen that sends them rather than on a grid. Intake is what
 * feeds the composer, Delivery is what happens to an email on the way out,
 * Insight is the summary of the steps, and Setup is configuration. Dashboard is
 * deliberately not first and deliberately not the landing page; / still goes to
 * /write.
 *
 * Annotated rather than `as const`: with typedRoutes, a bare union of a dozen
 * literal hrefs makes Link infer its generic from the wrong member and reject
 * every other one.
 */
export interface NavItem {
  href: Route;
  label: string;
  icon: LucideIcon;
  /** Matched against the pathname; the alerts item also shows a live count. */
  badge?: "alerts";
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: "Work",
    items: [
      { href: "/write", label: "Write", icon: PenLine },
      { href: "/leads", label: "Leads", icon: Target },
      { href: "/contacts", label: "Contacts", icon: Users },
      { href: "/pipeline", label: "Pipeline", icon: SquareKanban },
    ],
  },
  {
    label: "Intake",
    items: [
      { href: "/import", label: "Import", icon: Upload },
      { href: "/review", label: "Review", icon: ClipboardCheck },
    ],
  },
  {
    label: "Delivery",
    items: [
      { href: "/audit", label: "Audit", icon: ShieldCheck },
      { href: "/queue", label: "Queue", icon: CalendarClock },
      { href: "/alerts", label: "Alerts", icon: Bell, badge: "alerts" },
    ],
  },
  {
    label: "Insight",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Setup",
    items: [
      { href: "/templates", label: "Templates", icon: FileText },
      { href: "/knowledge", label: "Knowledge", icon: BookOpen },
      { href: "/mailboxes", label: "Mailboxes", icon: Mailbox },
      { href: "/suppressions", label: "Suppressions", icon: Ban },
      { href: "/settings", label: "Settings", icon: Settings2 },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((group) => group.items);
