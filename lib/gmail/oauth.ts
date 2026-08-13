// Google OAuth for SENDING, which is a different grant from signing in.
//
// Supabase's Google provider authenticates a person for the length of a
// session. It will not hand back a durable refresh token, and a background job
// that runs at 07:00 prospect-local has nobody sitting at a browser to consent.
// So this is a second, separate grant against the same Cloud project: our own
// client id, our own redirect, our own refresh token, stored in
// mailbox_secrets and never exposed to a browser.

/**
 * Exactly two scopes, and the omission is the point.
 *
 * `gmail.modify` is deliberately absent. Instantly's warmup mail lives in these
 * same mailboxes and has to keep sitting in the inbox, read state untouched.
 * Without the scope the app is structurally incapable of archiving, labelling
 * or marking anything read — a property no amount of care in the code can
 * match, because it survives a bug.
 *
 * gmail.readonly is what lets the poller see replies and bounces, and what
 * users.getProfile needs to tell us which address the grant is actually for.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export class GoogleAuthError extends Error {
  /**
   * True when Google says the grant itself is dead — revoked in the account's
   * security settings, or expired because the consent screen was left in
   * External/Testing mode, where refresh tokens die after seven days. The
   * caller marks the mailbox disconnected rather than retrying.
   */
  readonly revoked: boolean;
  readonly status: number;

  constructor(message: string, options: { revoked?: boolean; status?: number } = {}) {
    super(message);
    this.name = "GoogleAuthError";
    this.revoked = options.revoked ?? false;
    this.status = options.status ?? 0;
  }
}

export interface TokenGrant {
  accessToken: string;
  /** Only present on the first exchange, and only with prompt=consent. */
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
}

export function buildAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Pre-selects the account in the chooser. A hint, never a restriction. */
  loginHint?: string | null;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPES.join(" "));

  // access_type=offline asks for a refresh token; prompt=consent forces the
  // consent screen even for an account that has already granted these scopes.
  // Without the second, Google returns a refresh token exactly once per account
  // and silently omits it on every reconnect after that — which looks like a
  // working flow right up until the access token expires an hour later.
  //
  // select_account is the third, and it is not cosmetic. Without it Google
  // uses whichever account the browser already has a session for and never
  // offers a choice. An operator signed into a personal Gmail in the same
  // browser gets sent down the flow as that account with no way to say
  // otherwise. login_hint below is only a hint, and Google ignores it when the
  // hinted account is not the active session.
  //
  // Connecting the wrong mailbox is not a cosmetic failure either: it is the
  // account every subsequent cold email would be sent from.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");

  // Do not widen the grant with whatever the user happened to approve
  // elsewhere. The two scopes above are the whole surface.
  url.searchParams.set("include_granted_scopes", "false");

  url.searchParams.set("state", input.state);
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);

  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || payload.error) {
    throw new GoogleAuthError(
      payload.error_description ?? payload.error ?? `token endpoint ${response.status}`,
      {
        // invalid_grant is the only error that means "stop retrying and get a
        // human to re-consent". Everything else may be transient.
        revoked: payload.error === "invalid_grant",
        status: response.status,
      },
    );
  }

  return payload;
}

function grantFrom(payload: TokenResponse): TokenGrant {
  if (!payload.access_token) {
    throw new GoogleAuthError("Google returned no access token.");
  }
  // 60 seconds of headroom, so a token that is technically alive when we check
  // it is not dead by the time the send lands.
  const seconds = (payload.expires_in ?? 3600) - 60;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: new Date(Date.now() + seconds * 1000),
    scope: payload.scope ?? "",
  };
}

export async function exchangeCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<TokenGrant> {
  return grantFrom(
    await postToken(
      new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
      }),
    ),
  );
}

export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenGrant> {
  return grantFrom(
    await postToken(
      new URLSearchParams({
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
      }),
    ),
  );
}

export interface GmailProfile {
  emailAddress: string;
  /** Cursor for the reply poller. Opaque and monotonic; never do maths on it. */
  historyId: string;
}

/**
 * Which mailbox this grant is actually for.
 *
 * Asked rather than assumed: the account chooser lets someone consent as a
 * different address than the one they signed into the app with, and a mailbox
 * row whose email does not match its tokens sends every subsequent email from
 * the wrong place.
 */
export async function fetchProfile(accessToken: string): Promise<GmailProfile> {
  const response = await fetch(PROFILE_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GoogleAuthError(`profile lookup failed (${response.status}) ${detail}`, {
      revoked: response.status === 401,
      status: response.status,
    });
  }

  const payload = (await response.json()) as {
    emailAddress?: string;
    historyId?: string | number;
  };

  if (!payload.emailAddress) {
    throw new GoogleAuthError("Google returned a profile with no address.");
  }

  return {
    emailAddress: payload.emailAddress,
    historyId: String(payload.historyId ?? ""),
  };
}

/** Every requested scope came back. A partial grant cannot send or poll. */
export function grantIsComplete(scope: string): boolean {
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return GMAIL_SCOPES.every((needed) => granted.has(needed));
}
