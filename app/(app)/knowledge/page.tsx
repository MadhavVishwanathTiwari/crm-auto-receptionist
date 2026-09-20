import { requireOrgContext } from "@/lib/org";
import { selectAll, selectUpTo } from "@/lib/supabase/paginate";

import { KnowledgeClient, type AiReplyRow, type KbRow } from "./KnowledgeClient";

import { LoadError } from "@/components/ui/LoadError";
import { Page, PageBody, PageHeader } from "@/components/ui/PageShell";

export const dynamic = "force-dynamic";

/** Enough to calibrate a prompt, not so many that the page becomes a log. */
const RECENT_LIMIT = 50;

export default async function KnowledgePage() {
  const { supabase, role } = await requireOrgContext();

  const [settingsResult, entriesResult, repliesResult] = await Promise.all([
    supabase
      .from("org_settings")
      .select("business_context, ai_reply_mode, booking_url")
      .maybeSingle(),

    // The whole knowledge base, every time: this is the screen for editing it,
    // and a page of it with the rest silently missing is worse than an error.
    selectAll<KbRow>(() =>
      supabase.from("kb_entries").select("id, question, answer, is_active, sort_order"),
    ),

    // The newest N. selectUpTo, not selectAll: nothing here decides whether an
    // email goes out, so a screen showing the most recent is the right shape.
    selectUpTo<AiReplyRow & { leads: { company_name: string | null } | null }>(
      () =>
        supabase
          .from("ai_replies")
          .select(
            "id, lead_id, outcome, intent, reason, needs_human, draft_subject, " +
              "draft_body, inbound_received_at, sent_at, created_at, error, " +
              "leads(company_name)",
          )
          .order("created_at", { ascending: false }),
      RECENT_LIMIT,
    ),
  ]);

  const settings = settingsResult.data as
    | { business_context: string; ai_reply_mode: string; booking_url: string | null }
    | null;

  const failure =
    settingsResult.error?.message ??
    entriesResult.error?.message ??
    repliesResult.error?.message ??
    null;

  if (failure) {
    return (
      <Page>
        <PageHeader title="Knowledge" />
        <PageBody width="prose">
          <LoadError what="the knowledge base" message={failure} />
        </PageBody>
      </Page>
    );
  }

  const entries = [...entriesResult.data].sort(
    (a, b) => a.sort_order - b.sort_order || a.question.localeCompare(b.question),
  );

  const replies: AiReplyRow[] = repliesResult.data.map((row) => ({
    id: row.id,
    lead_id: row.lead_id,
    company_name: row.leads?.company_name ?? null,
    outcome: row.outcome,
    intent: row.intent,
    reason: row.reason,
    needs_human: row.needs_human,
    draft_subject: row.draft_subject,
    draft_body: row.draft_body,
    inbound_received_at: row.inbound_received_at,
    sent_at: row.sent_at,
    created_at: row.created_at,
    error: row.error,
  }));

  const mode = settings?.ai_reply_mode ?? "off";

  return (
    <Page>
      <PageHeader
        title="Knowledge"
        subtitle={`${entries.filter((e) => e.is_active).length} active`}
        meta={
          mode === "off"
            ? "The assistant is off. Nothing here is being read yet."
            : mode === "draft"
              ? "Draft mode: it writes what it would send, and sends nothing."
              : "Live: it is answering prospects nobody replied to in time."
        }
        note="Everything the assistant is allowed to say, and everything it has said."
      />
      <PageBody width="wide">
        <KnowledgeClient
          businessContext={settings?.business_context ?? ""}
          bookingUrl={settings?.booking_url ?? null}
          mode={mode}
          entries={entries}
          replies={replies}
          canEdit={role === "admin"}
        />
      </PageBody>
    </Page>
  );
}
