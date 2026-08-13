import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER } from "../ui";
import { TemplateEditor, type TemplateRow } from "./TemplateEditor";

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
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Templates</h1>
        <span className="ml-auto text-[var(--color-ink-3)]">
          No em dashes. Loss-framed. One binary-choice ask.
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-4 py-6 text-[var(--color-danger)]">
            Could not load templates: {error.message}
          </p>
        ) : (
          <TemplateEditor
            rows={(data ?? []) as TemplateRow[]}
            isAdmin={role === "admin"}
          />
        )}
      </div>
    </div>
  );
}
