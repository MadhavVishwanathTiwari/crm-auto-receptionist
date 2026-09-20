"use client";

import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { formatYours } from "@/lib/time/format";
import { toast } from "@/lib/ui/toast";

import { useViewerZone } from "../ViewerZone";
import {
  deleteKbEntry,
  setKbEntryActive,
  updateBusinessContext,
  upsertKbEntry,
} from "./actions";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import type { Tone } from "@/lib/ui/tones";

export interface KbRow {
  id: string;
  question: string;
  answer: string;
  is_active: boolean;
  sort_order: number;
}

export interface AiReplyRow {
  id: string;
  lead_id: string;
  company_name: string | null;
  outcome: string;
  intent: string | null;
  reason: string;
  needs_human: boolean;
  draft_subject: string | null;
  draft_body: string | null;
  inbound_received_at: string;
  sent_at: string | null;
  created_at: string;
  error: string | null;
}

/**
 * What each outcome is worth looking at for.
 *
 * `skipped` is muted and is the majority: it is the assistant deciding not to
 * speak, which is the behaviour you want most of the time and not news. The
 * ones with colour are the ones that changed something or need somebody.
 */
const OUTCOME_TONE: Record<string, Tone> = {
  sent: "ok",
  drafted: "info",
  skipped: "muted",
  failed: "danger",
  stalled: "warn",
  sending: "warn",
};

function KbEditor({
  entry,
  canEdit,
  onDone,
}: {
  entry: KbRow | null;
  canEdit: boolean;
  onDone: () => void;
}) {
  const [question, setQuestion] = useState(entry?.question ?? "");
  const [answer, setAnswer] = useState(entry?.answer ?? "");
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = await upsertKbEntry({
        id: entry?.id,
        question,
        answer,
        sortOrder: entry?.sort_order,
      });
      if (result.ok) {
        toast.success(entry ? "Answer updated." : "Answer added.");
        onDone();
      } else {
        toast.error(result.error ?? "That did not save.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <Field
        label="What they ask"
        hint="In their words, not ours. The assistant matches on meaning, so one phrasing is enough."
      >
        {(ids) => (
          <Input
            {...ids}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How much does it cost?"
            disabled={!canEdit}
          />
        )}
      </Field>

      <Field
        label="What it may say back"
        hint="Only what is true. Anything not written here, the assistant says a person will follow up on."
      >
        {(ids) => (
          <Textarea
            {...ids}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={4}
            disabled={!canEdit}
          />
        )}
      </Field>

      <div className="flex gap-2">
        <Button onClick={save} disabled={!canEdit || pending}>
          {pending ? "Saving…" : entry ? "Save" : "Add"}
        </Button>
        <Button variant="secondary" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function KbLine({ entry, canEdit }: { entry: KbRow; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      const result = await setKbEntryActive(entry.id, !entry.is_active);
      if (!result.ok) toast.error(result.error ?? "That did not save.");
    });
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteKbEntry(entry.id);
      if (result.ok) toast.success("Answer removed.");
      else toast.error(result.error ?? "That did not delete.");
    });
  }

  if (editing) {
    return (
      <li className="border-b border-line px-4 py-3 last:border-0">
        <KbEditor entry={entry} canEdit={canEdit} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="border-b border-line px-4 py-2.5 last:border-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={
                entry.is_active ? "font-medium text-ink" : "font-medium text-ink-3"
              }
            >
              {entry.question}
            </span>
            {!entry.is_active && <Badge tone="muted">off</Badge>}
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-ink-2">{entry.answer}</p>
        </div>

        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={toggle} disabled={pending}>
              {entry.is_active ? "Turn off" : "Turn on"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={remove}
              disabled={pending}
              aria-label="Delete this answer"
            >
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function ReplyLine({ reply, zone }: { reply: AiReplyRow; zone: string | null }) {
  const [open, setOpen] = useState(false);
  const body = reply.draft_body?.trim();

  return (
    <li className="border-b border-line px-4 py-2 last:border-0">
      <div className="flex items-baseline gap-3">
        <Badge tone={OUTCOME_TONE[reply.outcome] ?? "neutral"}>{reply.outcome}</Badge>

        <Link
          href={{ pathname: "/leads", query: { lead: reply.lead_id } }}
          className="shrink-0 font-medium text-ink hover:text-accent"
        >
          {reply.company_name ?? "a lead"}
        </Link>

        <span className="min-w-0 flex-1 truncate text-ink-2">{reply.reason}</span>

        {reply.needs_human && <Badge tone="warn">over to you</Badge>}

        <span className="tabular shrink-0 text-ink-3">
          {formatYours(reply.created_at, zone, "datetime")}
        </span>

        {body && (
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Read"}
          </Button>
        )}
      </div>

      {open && body && (
        <div className="mt-2 rounded-md border border-line bg-surface-2 p-3">
          {reply.draft_subject && (
            <p className="mb-2 font-medium text-ink">{reply.draft_subject}</p>
          )}
          <p className="whitespace-pre-wrap text-ink-2">{body}</p>
        </div>
      )}

      {reply.error && (
        <p className="mt-1 text-danger">{reply.error}</p>
      )}
    </li>
  );
}

export function KnowledgeClient({
  businessContext,
  bookingUrl,
  mode,
  entries,
  replies,
  canEdit,
}: {
  businessContext: string;
  bookingUrl: string | null;
  mode: string;
  entries: KbRow[];
  replies: AiReplyRow[];
  canEdit: boolean;
}) {
  const { zone } = useViewerZone();
  const [context, setContext] = useState(businessContext);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  const contextDirty = context !== businessContext;

  function saveContext() {
    startTransition(async () => {
      const result = await updateBusinessContext(context);
      if (result.ok) toast.success("Saved.");
      else toast.error(result.error ?? "That did not save.");
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="About the business"
          subtitle="Read on every reply. Who we are, what we sell, and how you want it said."
        />
        <CardBody className="space-y-3">
          <Textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={10}
            disabled={!canEdit}
            placeholder={
              "We build AI receptionists for home service businesses…\n\n" +
              "Keep it factual. Anything not written here, the assistant will not say."
            }
          />
          <div className="flex items-center gap-3">
            <Button onClick={saveContext} disabled={!canEdit || !contextDirty || pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            {mode !== "off" && !bookingUrl && (
              <span className="text-warn">
                No booking link is set, so the assistant cannot answer anybody.{" "}
                <Link href="/settings" className="underline">
                  Settings
                </Link>
              </span>
            )}
            {!canEdit && (
              <span className="text-ink-3">
                Only an admin can change what the assistant says.
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Answers it may give"
          subtitle="A question it can answer from here, it answers. Anything else, it says you will follow up."
          actions={
            canEdit && !adding ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add
              </Button>
            ) : null
          }
        />
        {adding && (
          <CardBody className="border-b border-line">
            <KbEditor entry={null} canEdit={canEdit} onDone={() => setAdding(false)} />
          </CardBody>
        )}
        {entries.length === 0 && !adding ? (
          <CardBody>
            <EmptyState
              compact
              title="Nothing here yet"
              body="Until something is, the assistant can only say that a person will follow up."
            />
          </CardBody>
        ) : (
          <ul>
            {entries.map((entry) => (
              <KbLine key={entry.id} entry={entry} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="What it did"
          subtitle="The last 50, newest first. Most are skips, and the reason is the point."
        />
        {replies.length === 0 ? (
          <CardBody>
            <EmptyState
              compact
              title="It has not been asked to answer anything yet"
              body="A reply nobody answers within the head start on Settings shows up here."
            />
          </CardBody>
        ) : (
          <ul>
            {replies.map((reply) => (
              <ReplyLine key={reply.id} reply={reply} zone={zone} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
