// Access tokens for a connected mailbox.
//
// The refresh token is the durable thing and lives in mailbox_secrets, which no
// browser-reachable client can read. Access tokens last an hour and are cached
// beside it, so a dispatch run of forty sends mints one rather than forty.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env";

import { GoogleAuthError, refreshAccessToken } from "./oauth";

export interface MailboxToken {
  accessToken: string;
}

/**
 * Thrown when the mailbox itself is the problem rather than the request.
 *
 * The caller stops working that mailbox for the rest of the run: every send
 * queued behind a dead grant would otherwise fail one at a time, forty times.
 */
export class MailboxDisconnectedError extends Error {
  readonly mailboxId: string;

  constructor(mailboxId: string, message: string) {
    super(message);
    this.name = "MailboxDisconnectedError";
    this.mailboxId = mailboxId;
  }
}

/**
 * Marks a mailbox as needing re-consent, once.
 *
 * Three writes because they answer three different questions: the mailbox stops
 * being picked up by the claimer, the health log records what happened, and the
 * alert is what a human actually sees. The alert's dedupe_token is the mailbox
 * id, so a poller running every ten minutes against a revoked grant produces
 * one row rather than a hundred and forty a day.
 */
export async function markMailboxDisconnected(
  supabase: SupabaseClient,
  mailbox: { id: string; org_id: string; email: string },
  detail: string,
): Promise<void> {
  await supabase
    .from("mailboxes")
    .update({ disconnected_at: new Date().toISOString() })
    .eq("id", mailbox.id)
    .is("disconnected_at", null);

  await supabase.from("mailbox_events").insert({
    org_id: mailbox.org_id,
    mailbox_id: mailbox.id,
    kind: "auth_error",
    detail,
  });

  await supabase.from("alerts").upsert(
    {
      org_id: mailbox.org_id,
      mailbox_id: mailbox.id,
      kind: "mailbox_auth",
      message: `${mailbox.email} needs reconnecting: ${detail}`,
      dedupe_token: mailbox.id,
    },
    { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
  );
}

/**
 * A usable access token for this mailbox, refreshing if the cached one is spent.
 *
 * Requires the service role: mailbox_secrets has RLS on and no policies at all.
 */
export async function getMailboxAccessToken(
  supabase: SupabaseClient,
  mailbox: { id: string; org_id: string; email: string },
): Promise<MailboxToken> {
  const { data: secret, error } = await supabase
    .from("mailbox_secrets")
    .select("refresh_token, access_token, access_token_expires_at")
    .eq("mailbox_id", mailbox.id)
    .maybeSingle();

  if (error) {
    throw new MailboxDisconnectedError(
      mailbox.id,
      `could not read the stored grant: ${error.message}`,
    );
  }
  if (!secret) {
    await markMailboxDisconnected(supabase, mailbox, "no stored grant");
    throw new MailboxDisconnectedError(mailbox.id, "no stored grant");
  }

  const expiresAt = secret.access_token_expires_at
    ? Date.parse(secret.access_token_expires_at as string)
    : 0;

  // The 60 seconds of headroom is already baked into what was stored, so this
  // is a plain comparison rather than another fudge factor on top of one.
  if (secret.access_token && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
    return { accessToken: secret.access_token as string };
  }

  const env = serverEnv();
  if (!env.googleOAuthClientId || !env.googleOAuthClientSecret) {
    throw new MailboxDisconnectedError(mailbox.id, "Google OAuth is not configured");
  }

  try {
    const grant = await refreshAccessToken({
      refreshToken: secret.refresh_token as string,
      clientId: env.googleOAuthClientId,
      clientSecret: env.googleOAuthClientSecret,
    });

    await supabase
      .from("mailbox_secrets")
      .update({
        access_token: grant.accessToken,
        access_token_expires_at: grant.expiresAt.toISOString(),
        // Google may return a rotated refresh token. When it does not, keep the
        // one we have: writing null here would disconnect a working mailbox.
        ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
      })
      .eq("mailbox_id", mailbox.id);

    return { accessToken: grant.accessToken };
  } catch (cause) {
    if (cause instanceof GoogleAuthError && cause.revoked) {
      await markMailboxDisconnected(
        supabase,
        mailbox,
        "the Google grant was revoked or expired",
      );
      throw new MailboxDisconnectedError(mailbox.id, "the Google grant was revoked");
    }
    // A transient token-endpoint failure is not a reason to disconnect a
    // mailbox a human would then have to reconnect by hand.
    throw cause;
  }
}
