import { describe, expect, it } from "vitest";

import { googleRedirectUri } from "@/lib/gmail/redirect";
import { requestOrigin } from "@/lib/requestOrigin";

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe("the origin the browser actually asked for", () => {
  it("prefers the forwarded host over the internal request URL", () => {
    // This is the production shape: Vercel hands the handler an internal URL
    // and puts the real one in the forwarded headers.
    expect(
      requestOrigin(
        req("http://localhost:3000/api/auth/google/start", {
          "x-forwarded-host": "crm.autoreceptionist.io",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://crm.autoreceptionist.io");
  });

  it("falls back to the request URL when nothing forwarded it", () => {
    expect(requestOrigin(req("http://127.0.0.1:3000/api/auth/google/start"))).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("assumes https when a host was forwarded without a scheme", () => {
    expect(
      requestOrigin(
        req("http://localhost:3000/x", { "x-forwarded-host": "crm.example.test" }),
      ),
    ).toBe("https://crm.example.test");
  });
});

describe("the Google redirect URI", () => {
  it("comes back to the host the operator left from", () => {
    // The regression this exists for: production was deployed with a local
    // NEXT_PUBLIC_SITE_URL, so a Connect click on crm.autoreceptionist.io sent
    // Google a 127.0.0.1 redirect_uri. Google obeyed, delivered the code to the
    // operator's own laptop, and the state cookie left on the production host
    // could not be read there. It surfaced as state_mismatch on a login page.
    expect(
      googleRedirectUri(
        req("http://localhost:3000/api/auth/google/start", {
          "x-forwarded-host": "crm.autoreceptionist.io",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://crm.autoreceptionist.io/api/auth/google/callback");

    expect(
      googleRedirectUri(req("http://127.0.0.1:3000/api/auth/google/start")),
    ).toBe("http://127.0.0.1:3000/api/auth/google/callback");
  });

  it("agrees between the authorization request and the token exchange", () => {
    // Google refuses the exchange unless the two match, and both halves derive
    // it the same way from their own request, so they cannot drift.
    const headers = {
      "x-forwarded-host": "crm.autoreceptionist.io",
      "x-forwarded-proto": "https",
    };
    expect(googleRedirectUri(req("http://localhost:3000/api/auth/google/start", headers))).toBe(
      googleRedirectUri(req("http://localhost:3000/api/auth/google/callback", headers)),
    );
  });
});
