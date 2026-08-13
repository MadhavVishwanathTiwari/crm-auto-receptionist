import { pushIsConfigured } from "@/lib/notify/push";
import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER, PANEL } from "../ui";
import { type AlertRow, AlertList } from "./AlertList";

export const dynamic = "force-dynamic";

/** Enough history to answer "did we hear back from them", not an archive. */
const LIMIT = 200;

export default async function AlertsPage() {
  const { supabase } = await requireOrgContext();

  const { data, error } = await supabase
    .from("alerts")
    .select("id, kind, message, lead_id, acknowledged_at, created_at, leads(company_name)")
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  // PostgREST returns an embedded to-one relation as an object, but as an array
  // when it cannot prove the relationship is to-one. Same normalisation the
  // queue does, for the same reason.
  const rows: AlertRow[] = (data ?? []).map((row) => {
    const embedded = (row as { leads?: unknown }).leads;
    const lead = (Array.isArray(embedded) ? embedded[0] : embedded) as
      | { company_name: string | null }
      | undefined;

    return {
      id: row.id as string,
      kind: row.kind as string,
      message: row.message as string,
      lead_id: row.lead_id as string | null,
      acknowledged_at: row.acknowledged_at as string | null,
      created_at: row.created_at as string,
      lead_company: lead?.company_name ?? null,
    };
  });

  const open = rows.filter((row) => !row.acknowledged_at).length;

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Alerts</h1>
        <span className="tabular text-[var(--color-ink-3)]">
          {open} open · {rows.length} in the last {LIMIT}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-[1100px] space-y-4">
          {error && (
            <p role="alert" className={PANEL + " text-[var(--color-danger)]"}>
              Could not load the alerts: {error.message}
            </p>
          )}
          <AlertList rows={rows} />

          {!pushIsConfigured() && (
            <p className={PANEL + " text-[var(--color-ink-3)]"}>
              Nothing is pushed to a phone yet, so a reply waits until somebody
              opens this page. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS (or
              NTFY_TOPIC) and the poller starts sending each new alert on as it
              finds it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
