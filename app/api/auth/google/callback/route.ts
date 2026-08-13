// Step two: turn Google's authorization code into a mailbox that can send.
//
// One of exactly three places CLAUDE.md permits the service-role key, and the
// reason is mailbox_secrets: that table has RLS on, no policies at all, and its
// grants to `authenticated` revoked outright. Nothing holding a user session
// can write a refresh token, which is the property that keeps a token one
// `select *` away from nobody.
//
// The user's own session is still read here, through the cookie client, to
// decide WHICH org the mailbox belongs to. The service role decides nothing; it
// only writes what this route has already established.

import { NextResponse, type NextRequest } from "next/server";

import { serverEnv } from "@/lib/env";
import {
  exchangeCode,
  fetchProfile,
  grantIsComplete,
  GoogleAuthError,
} from "@/lib/gmail/oauth";
import {
  googleRedirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
} from "@/lib/gmail/redirect";
import { normalizeEmail } from "@/lib/normalize";
import { getOrgContext } from "@/lib/org";
import { createAdminSupabase } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function back(request: NextRequest, params: Record<string, string>) {
  const url = new URL("/mailboxes", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = NextResponse.redirect(url);
  // Single use, whatever the outcome.
  response.cookies.delete({
    name: OAUTH_STATE_COOKIE,
    path: OAUTH_STATE_COOKIE_PATH,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  // The operator declined at the consent screen, or Google refused. Neither is
  // an error worth a stack trace; it is a sentence on the mailboxes page.
  const denied = params.get("error");
  if (denied) return back(request, { error: denied });

  const code = params.get("code");
  const state = params.get("state");
  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value;

  if (!code) return back(request, { error: "no_code" });
  if (!state || !expected || state !== expected) {
    return back(request, { error: "state_mismatch" });
  }

  const context = await getOrgContext();
  if (!context) return NextResponse.redirect(new URL("/login", request.url));

  const env = serverEnv();
  if (!env.googleOAuthClientId || !env.googleOAuthClientSecret) {
    return back(request, { error: "google_not_configured" });
  }

  try {
    const grant = await exchangeCode({
      code,
      clientId: env.googleOAuthClientId,
      clientSecret: env.googleOAuthClientSecret,
      redirectUri: googleRedirectUri(),
    });

    // Without a refresh token this mailbox can send for one hour and then stop,
    // in the middle of a sequence, with no way to recover unattended. Refusing
    // now is far cheaper than discovering it at 07:00.
    if (!grant.refreshToken) {
      return back(request, { error: "no_refresh_token" });
    }
    if (!grantIsComplete(grant.scope)) {
      return back(request, { error: "partial_scopes" });
    }

    // Which address the grant is actually for. The chooser lets someone consent
    // as a different account than the one they signed into the app with.
    const profile = await fetchProfile(grant.accessToken);
    const emailNorm = normalizeEmail(profile.emailAddress);
    if (!emailNorm) return back(request, { error: "bad_address" });

    const admin = createAdminSupabase();

    // email_norm is a GENERATED column, so it cannot be an ON CONFLICT arbiter
    // from supabase-js — the same trap the leads dedupe index documents. Look
    // it up, then insert or update.
    const { data: existing, error: lookupError } = await admin
      .from("mailboxes")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("email_norm", emailNorm)
      .maybeSingle();

    if (lookupError) return back(request, { error: "lookup_failed" });

    let mailboxId: string;

    if (existing) {
      // A reconnect. Clear the disconnection and hand it to whoever just
      // consented, but leave cap, ramp and timezone exactly as they were: those
      // are the operator's settings, not Google's.
      const { data: updated, error: updateError } = await admin
        .from("mailboxes")
        .update({
          user_id: context.userId,
          // display_name is left alone. It is what a prospect sees in the From
          // header and what {{sender_name}} renders, so it is the operator's to
          // set on the mailboxes screen, not Google's to overwrite.
          disconnected_at: null,
        })
        .eq("id", existing.id)
        .select("id");

      if (updateError || !updated || updated.length === 0) {
        return back(request, { error: "reconnect_failed" });
      }
      mailboxId = existing.id as string;
    } else {
      const { data: settings } = await admin
        .from("org_settings")
        .select("operator_timezone")
        .eq("org_id", context.orgId)
        .maybeSingle();

      const { data: created, error: insertError } = await admin
        .from("mailboxes")
        .insert({
          org_id: context.orgId,
          user_id: context.userId,
          email: profile.emailAddress,
          // Deliberately null. A From header reading "ojas@x.com <ojas@x.com>"
          // is worse than a bare address, and a template that interpolates
          // {{sender_name}} should visibly refuse to send rather than quietly
          // put an email address where a human name belongs.
          display_name: null,
          provider: "gmail",
          // Caps reset in THIS zone, not the prospect's. Seeded from the org
          // default and correctable on the mailboxes screen.
          timezone: settings?.operator_timezone ?? "America/New_York",
        })
        .select("id")
        .single();

      if (insertError || !created) return back(request, { error: "create_failed" });
      mailboxId = created.id as string;
    }

    const { error: secretError } = await admin.from("mailbox_secrets").upsert(
      {
        mailbox_id: mailboxId,
        refresh_token: grant.refreshToken,
        access_token: grant.accessToken,
        access_token_expires_at: grant.expiresAt.toISOString(),
        scope: grant.scope,
        connected_by: context.userId,
      },
      { onConflict: "mailbox_id" },
    );

    if (secretError) return back(request, { error: "secret_write_failed" });

    // Baseline the reply poller here rather than letting it start from zero.
    // Gmail's history list is only valid from a real historyId, and starting
    // from the profile's current value means the first poll reports what has
    // happened since the mailbox was connected instead of failing outright.
    await admin
      .from("mailboxes")
      .update({ last_history_id: profile.historyId || null })
      .eq("id", mailboxId);

    await admin.from("mailbox_events").insert({
      org_id: context.orgId,
      mailbox_id: mailboxId,
      kind: "resumed",
      detail: `connected by ${context.email ?? context.userId}`,
      payload: { scope: grant.scope },
    });

    return back(request, { connected: profile.emailAddress });
  } catch (error) {
    if (error instanceof GoogleAuthError) {
      return back(request, { error: error.revoked ? "grant_revoked" : "google_error" });
    }
    return back(request, { error: "unexpected" });
  }
}
