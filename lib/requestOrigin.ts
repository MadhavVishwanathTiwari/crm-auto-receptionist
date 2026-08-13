// The origin the BROWSER actually asked for.
//
// `new URL(request.url).origin` is not it. Behind Vercel the request reaching
// the handler carries the internal origin, and this deployment has been
// observed serving crm.autoreceptionist.io while `request.url` says something
// else entirely. The forwarded headers are what the browser sent.
//
// This logic already existed inline in app/auth/callback/route.ts with a
// comment explaining it. It is here because the Google OAuth routes need the
// same answer, and the one time they used a configured value instead, a
// production Connect click sent an operator to a redirect on 127.0.0.1 and
// dead-ended on their own laptop.

export function requestOrigin(request: Request): string {
  // Vercel overwrites x-forwarded-host from the real Host header, so a client
  // cannot forge it here. It matters that they cannot: this value ends up as
  // an OAuth redirect_uri. Google refuses any redirect_uri that is not on the
  // client's registered list, which is the actual guarantee either way.
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${forwardedHost}`;
  }

  return new URL(request.url).origin;
}
