"use client";

import { useMemo, useState, useTransition } from "react";

// Both come from a plain module, never through the "use server" actions file.
import { lintTemplate, TEMPLATE_VARIABLES } from "@/lib/templates/lint";

import { BUTTON, BUTTON_QUIET, INPUT, PANEL } from "../ui";
import { deleteTemplate, saveTemplate, setTemplateActive } from "./actions";

export interface TemplateRow {
  id: string;
  name: string;
  step_number: number;
  angle_type: string | null;
  subject: string;
  body: string;
  requires_demo: boolean;
  is_active: boolean;
  updated_at: string;
}

const BLANK = {
  id: null as string | null,
  name: "",
  step_number: 1,
  angle_type: null as string | null,
  subject: "",
  body: "",
  requires_demo: false,
  is_active: false,
};

const ANGLES = [
  { value: "", label: "Either angle" },
  { value: "soft_text_audit", label: "Soft text audit" },
  { value: "voicemail_drop_audit", label: "Voicemail drop audit" },
];

export function TemplateEditor({
  rows,
  isAdmin,
}: {
  rows: TemplateRow[];
  isAdmin: boolean;
}) {
  const [draft, setDraft] = useState<typeof BLANK>(BLANK);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // The same rules the trigger enforces, run as you type. The database is still
  // the guarantee; this is so nobody discovers the rule by being refused.
  const violations = useMemo(
    () => lintTemplate(draft.subject, draft.body),
    [draft.subject, draft.body],
  );

  function edit(row: TemplateRow) {
    setError(null);
    setSaved(false);
    setDraft({
      id: row.id,
      name: row.name,
      step_number: row.step_number,
      angle_type: row.angle_type,
      subject: row.subject,
      body: row.body,
      requires_demo: row.requires_demo,
      is_active: row.is_active,
    });
  }

  function save(activate: boolean) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveTemplate({
        id: draft.id,
        name: draft.name,
        stepNumber: draft.step_number,
        angleType: (draft.angle_type as "soft_text_audit" | null) ?? null,
        subject: draft.subject,
        body: draft.body,
        requiresDemo: draft.requires_demo,
        isActive: activate,
      });
      if (result.ok) {
        setDraft((d) => ({ ...d, id: result.id ?? d.id, is_active: activate }));
        setSaved(true);
      } else {
        setError(result.error ?? "That did not save.");
      }
    });
  }

  function toggleActive(row: TemplateRow) {
    setError(null);
    startTransition(async () => {
      const result = await setTemplateActive(row.id, !row.is_active);
      if (!result.ok) setError(result.error ?? "That did not work.");
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteTemplate(id);
      if (result.ok && draft.id === id) setDraft(BLANK);
      else if (!result.ok) setError(result.error ?? "That did not work.");
    });
  }

  return (
    <div className="space-y-4 p-4">
      <div className={PANEL}>
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="text-[var(--color-ink)]">
            {draft.id ? "Edit template" : "New template"}
          </h2>
          {draft.id && (
            <button
              type="button"
              onClick={() => setDraft(BLANK)}
              className={BUTTON_QUIET}
            >
              start a new one
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="T1 soft text"
              className={INPUT + " w-56"}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">Step</span>
            <select
              value={draft.step_number}
              onChange={(e) =>
                setDraft({ ...draft, step_number: Number(e.target.value) })
              }
              className={INPUT}
            >
              {[1, 2, 3, 4].map((step) => (
                <option key={step} value={step}>
                  T{step}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">Angle</span>
            <select
              value={draft.angle_type ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, angle_type: e.target.value || null })
              }
              className={INPUT}
            >
              {ANGLES.map((angle) => (
                <option key={angle.value} value={angle.value}>
                  {angle.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.requires_demo}
              onChange={(e) =>
                setDraft({ ...draft, requires_demo: e.target.checked })
              }
            />
            <span className="text-[var(--color-ink-2)]">Needs a built demo</span>
          </label>
        </div>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">Subject</span>
          <input
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            className={INPUT + " w-full"}
          />
        </label>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">Body</span>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={12}
            className={INPUT + " w-full font-mono"}
          />
        </label>

        <p className="mt-2 text-[var(--color-ink-3)]">
          Variables:{" "}
          {TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" ")}
        </p>

        <div className="mt-3">
          {violations.length === 0 ? (
            <p className="text-[var(--color-ok)]">
              Lints clean. This can go live.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {violations.map((violation) => (
                <li key={violation.rule} className="text-[var(--color-warn)]">
                  {violation.message}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => save(false)}
            disabled={pending || !draft.name.trim()}
            className={BUTTON}
          >
            Save draft
          </button>
          <button
            type="button"
            onClick={() => save(true)}
            disabled={pending || violations.length > 0 || !draft.name.trim()}
            className={BUTTON}
          >
            Save and activate
          </button>
        </div>

        {saved && !error && <p className="mt-2 text-[var(--color-ok)]">Saved.</p>}
        {error && (
          <p role="alert" className="mt-2 text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>

      <div className={PANEL}>
        <h2 className="mb-3 text-[var(--color-ink)]">
          Templates{" "}
          <span className="tabular text-[var(--color-ink-3)]">{rows.length}</span>
        </h2>

        {rows.length === 0 ? (
          <p className="text-[var(--color-ink-3)]">
            Nothing written yet. The planner cannot book a step with no active
            template for it.
          </p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[var(--color-ink-3)]">
                <th className="py-1 font-normal">Name</th>
                <th className="py-1 font-normal">Step</th>
                <th className="py-1 font-normal">Angle</th>
                <th className="py-1 font-normal">Subject</th>
                <th className="py-1 font-normal">State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-[var(--color-line)]">
                  <td className="py-1">{row.name}</td>
                  <td className="tabular py-1">T{row.step_number}</td>
                  <td className="py-1 text-[var(--color-ink-2)]">
                    {row.angle_type?.replace(/_/g, " ") ?? "either"}
                  </td>
                  <td className="max-w-[320px] truncate py-1 text-[var(--color-ink-2)]">
                    {row.subject}
                  </td>
                  <td className="py-1">
                    {row.is_active ? (
                      <span className="text-[var(--color-ok)]">active</span>
                    ) : (
                      <span className="text-[var(--color-ink-3)]">draft</span>
                    )}
                  </td>
                  <td className="py-1 text-right">
                    <button
                      type="button"
                      onClick={() => edit(row)}
                      className={BUTTON_QUIET}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => toggleActive(row)}
                      className={BUTTON_QUIET}
                    >
                      {row.is_active ? "deactivate" : "activate"}
                    </button>
                    {isAdmin && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => remove(row.id)}
                        className={BUTTON_QUIET}
                      >
                        delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
