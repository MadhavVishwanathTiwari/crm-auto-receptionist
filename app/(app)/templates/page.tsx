import { requireOrgContext } from "@/lib/org";

import { TemplateEditor, type TemplateRow } from "./TemplateEditor";

import { Page, PageHeader } from "@/components/ui/PageShell";
import { LoadError } from "@/components/ui/LoadError";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const { supabase, role } = await requireOrgContext();

  const { data, error } = await supabase
    .from("templates")
    .select(
      "id, name, step_number, angle_type, subject, body, requires_demo, is_active, updated_at",
    )
    .order("step_number", { ascending: true })
    .order("name", { ascending: true });

  return (
    <Page>
      <PageHeader
        title="Templates"
        note="No em dashes. Loss-framed. One binary-choice ask."
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <LoadError what="templates" message={error.message} />
        ) : (
          <TemplateEditor
            rows={(data ?? []) as TemplateRow[]}
            isAdmin={role === "admin"}
          />
        )}
      </div>
    </Page>
  );
}
