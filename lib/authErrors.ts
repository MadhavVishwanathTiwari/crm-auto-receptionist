/**
 * Turns an auth failure into something a person can act on.
 *
 * GoTrue does not forward the Postgres exception raised by the allowlist
 * trigger. Whatever the trigger says, a rejected sign-in comes back as a flat
 * "Database error saving new user" (or "...creating new user", depending on the
 * path), which reads as a broken app rather than a closed door. Verified
 * against the live project with both an unlisted Workspace address and an
 * outside one.
 *
 * Shared by the callback route and the login page, because the same failure can
 * arrive at either: the callback when the redirect is allowlisted, the login
 * page via the Site URL fallback when it is not.
 */
export function describeAuthError(raw: string): string {
  if (/database error/i.test(raw)) {
    return (
      "That account is not on the allowlist for this app. " +
      "Sign in with your Auto Receptionist address, or ask an admin to add you."
    );
  }

  if (/signups? not allowed/i.test(raw)) {
    return (
      "New sign-ins are currently disabled for this project. " +
      "An admin has to re-enable them before a new account can be created."
    );
  }

  return raw;
}
