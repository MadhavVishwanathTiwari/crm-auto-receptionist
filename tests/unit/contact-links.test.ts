import { describe, expect, it } from "vitest";

import {
  displayName,
  socialHref,
  socialLinks,
  telHref,
  websiteHref,
} from "@/lib/contacts/links";

describe("socialHref", () => {
  it("passes a full URL through untouched", () => {
    expect(socialHref("instagram", "https://instagram.com/drsmith")).toBe(
      "https://instagram.com/drsmith",
    );
  });

  it("adds a protocol to a bare host", () => {
    expect(socialHref("linkedin", "linkedin.com/in/drsmith")).toBe(
      "https://linkedin.com/in/drsmith",
    );
  });

  it("adds a protocol to a www host", () => {
    expect(socialHref("facebook", "www.facebook.com/acmehvac")).toBe(
      "https://www.facebook.com/acmehvac",
    );
  });

  it("expands a handle written with an @", () => {
    expect(socialHref("twitter", "@drsmith")).toBe("https://x.com/drsmith");
  });

  it("expands a handle written without one", () => {
    expect(socialHref("instagram", "drsmith")).toBe("https://instagram.com/drsmith");
  });

  it("refuses a bare LinkedIn handle rather than guessing", () => {
    // /in/ is a person and /company/ is a business. Guessing wrong links to
    // somebody else entirely, so a value that is not already a URL stays text.
    expect(socialHref("linkedin", "drsmith")).toBeNull();
  });

  it("refuses empty and whitespace-only values", () => {
    expect(socialHref("instagram", "")).toBeNull();
    expect(socialHref("instagram", "   ")).toBeNull();
  });

  it("refuses a value with spaces in it", () => {
    // Clay sometimes leaves prose in these columns.
    expect(socialHref("instagram", "no account found")).toBeNull();
  });
});

describe("socialLinks", () => {
  it("returns personal before company, skipping the empties", () => {
    const links = socialLinks({
      personal_linkedin: "https://linkedin.com/in/drsmith",
      personal_instagram: null,
      personal_facebook: "   ",
      personal_twitter: "@drsmith",
      company_linkedin: null,
      company_instagram: "acmehvac",
      company_facebook: null,
      company_twitter: null,
    });

    expect(links.map((link) => `${link.scope}:${link.network}`)).toEqual([
      "personal:linkedin",
      "personal:twitter",
      "company:instagram",
    ]);
    expect(links[2].href).toBe("https://instagram.com/acmehvac");
  });

  it("keeps what the import stored, for the hover title", () => {
    const [link] = socialLinks({ personal_twitter: " @drsmith " });
    expect(link.raw).toBe("@drsmith");
    expect(link.href).toBe("https://x.com/drsmith");
  });

  it("is empty for a lead with no socials at all", () => {
    // Which is most of them: these columns are ~90% null on a scraped import.
    expect(socialLinks({})).toEqual([]);
  });
});

describe("websiteHref", () => {
  it("adds a protocol when the import omitted one", () => {
    expect(websiteHref("acmehvac.com")).toBe("https://acmehvac.com");
  });

  it("passes a full URL through", () => {
    expect(websiteHref("https://acmehvac.com/about")).toBe(
      "https://acmehvac.com/about",
    );
  });

  it("is null for nothing", () => {
    expect(websiteHref(null)).toBeNull();
    expect(websiteHref("  ")).toBeNull();
  });
});

describe("telHref", () => {
  it("prefers the normalised column", () => {
    expect(telHref({ phone_e164: "+15125551234", phone: "(512) 555-1234" })).toBe(
      "tel:+15125551234",
    );
  });

  it("falls back to what the import wrote", () => {
    // A number that would not normalise is still a number somebody can dial.
    expect(telHref({ phone_e164: null, phone: "(512) 555-1234" })).toBe(
      "tel:5125551234",
    );
  });

  it("is null with no number at all", () => {
    expect(telHref({ phone_e164: null, phone: null })).toBeNull();
  });
});

describe("displayName", () => {
  it("joins the parts the import filled", () => {
    expect(
      displayName({
        first_name: "Jane",
        middle_name: "Q",
        last_name: "Smith",
        name_suffix: "Jr",
      }),
    ).toBe("Jane Q Smith Jr");
  });

  it("skips the ones it did not", () => {
    expect(
      displayName({ first_name: "Jane", middle_name: null, last_name: "Smith" }),
    ).toBe("Jane Smith");
  });

  it("is empty when there is no person on the row", () => {
    // Common: a scraped business with no decision maker resolved yet. The card
    // falls back to the company name.
    expect(displayName({ first_name: null, last_name: null })).toBe("");
  });
});
