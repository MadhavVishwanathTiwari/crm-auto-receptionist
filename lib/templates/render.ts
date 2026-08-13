// Variable substitution for outreach copy.
//
// The one rule that matters: a variable with no value is NOT rendered as an
// empty string. "Hi , I texted at ." is worse than not sending, so
// renderTemplate reports what was missing and the dispatcher skips the send and
// raises an alert instead. Nothing here invents a fallback.

import { DateTime } from "luxon";

import { TEMPLATE_VARIABLES, type TemplateVariable } from "./lint";

export type TemplateValues = Partial<Record<TemplateVariable, string>>;

export interface RenderResult {
  text: string;
  /** Variables the template asked for that had no value. */
  missing: string[];
}

const VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

export function renderTemplate(
  text: string,
  values: TemplateValues,
): RenderResult {
  const missing = new Set<string>();

  const rendered = text.replace(VARIABLE, (_match, rawName: string) => {
    const name = rawName.toLowerCase() as TemplateVariable;
    const value = values[name];
    if (value === undefined || value === null || value.trim() === "") {
      missing.add(name);
      // Left in place so a template that somehow reaches a human eye shows
      // exactly which variable was hollow.
      return `{{${name}}}`;
    }
    return value;
  });

  return { text: rendered, missing: [...missing] };
}

export interface LeadForRender {
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  demo_txt_url: string | null;
  demo_web_url: string | null;
}

export interface EvidenceForRender {
  /** Wall-clock reading frozen at audit time. A `timestamp`, so no offset. */
  audited_at_local: string;
  audit_timezone: string;
  outcome: string | null;
  response_delay_seconds: number | null;
}

/** "3:12am", the way a human writes it back to another human. */
function formatLocalTime(local: DateTime): string {
  return local.toFormat("h:mma").toLowerCase();
}

/**
 * "never got a reply" / "4 hours later" / "26 minutes later".
 *
 * Null means the business never responded at all, which is the strongest
 * version of the pitch and must not be rendered as "0 seconds".
 */
function formatDelay(seconds: number | null): string {
  if (seconds === null) return "never got a reply";
  if (seconds < 90) return `${seconds} seconds later`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes later`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours later`;
  return `${Math.round(hours / 24)} days later`;
}

export function buildTemplateValues(input: {
  lead: LeadForRender;
  evidence: EvidenceForRender | null;
  senderName: string | null;
}): TemplateValues {
  const { lead, evidence, senderName } = input;

  // Parsed in the audit's own zone so the wall clock is preserved exactly as it
  // was captured, rather than being re-derived from the lead's current zone,
  // which an operator may have corrected since.
  const auditLocal = evidence
    ? DateTime.fromISO(evidence.audited_at_local, {
        zone: evidence.audit_timezone,
      })
    : null;

  return {
    first_name: lead.first_name ?? undefined,
    last_name: lead.last_name ?? undefined,
    company_name: lead.company_name ?? undefined,
    city: lead.city ?? undefined,
    state: lead.state ?? undefined,
    industry: lead.industry ?? undefined,
    audit_time_local:
      auditLocal && auditLocal.isValid ? formatLocalTime(auditLocal) : undefined,
    audit_day_local:
      auditLocal && auditLocal.isValid
        ? auditLocal.toFormat("cccc")
        : undefined,
    audit_outcome: evidence?.outcome ?? undefined,
    response_delay: evidence
      ? formatDelay(evidence.response_delay_seconds)
      : undefined,
    // The Auto-Receptionist repo emits exactly one URL; demo_txt_url is that
    // column, and the name refers to the outreach channel rather than a
    // text-only variant of the page.
    demo_url: lead.demo_txt_url ?? lead.demo_web_url ?? undefined,
    sender_name: senderName ?? undefined,
  };
}

/** Every variable name, for the editor's palette. */
export const RENDERABLE_VARIABLES = TEMPLATE_VARIABLES;
