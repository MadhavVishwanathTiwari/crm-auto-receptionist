// Golden vectors shared by two suites:
//   tests/unit/normalize.test.ts        — asserts the TypeScript behaviour
//   tests/integration/normalize-parity.test.ts — runs the SAME inputs through
//                                                the SQL functions and asserts
//                                                both implementations agree
//
// Adding a case here automatically strengthens both. That is the whole point:
// two implementations of a dedupe key is a latent data-corruption bug unless
// something forces them to stay identical.

export const EMAIL_VECTORS: Array<[string | null, string | null]> = [
  // basics
  ["Gabe@ExpertHVAC.com", "gabe@experthvac.com"],
  ["  info@acmeplumbing.com  ", "info@acmeplumbing.com"],
  ["INFO@ACME.COM", "info@acme.com"],

  // gmail: dots ignored, +tag stripped, googlemail is the same mailbox
  ["first.last@gmail.com", "firstlast@gmail.com"],
  ["first.last+leads@gmail.com", "firstlast@gmail.com"],
  ["FirstLast@googlemail.com", "firstlast@gmail.com"],
  ["a.b.c.d@gmail.com", "abcd@gmail.com"],

  // +tag stripped for known providers, dots preserved
  ["john.smith+ar@outlook.com", "john.smith@outlook.com"],
  ["jane+x@yahoo.com", "jane@yahoo.com"],
  ["me+tag@proton.me", "me@proton.me"],

  // NOT stripped on an arbitrary corporate domain: a false duplicate silently
  // discards a real lead, which is worse than a missed one landing in review
  ["dispatch+night@acmehvac.com", "dispatch+night@acmehvac.com"],
  ["first.last@acmehvac.com", "first.last@acmehvac.com"],

  // junk -> null, never the empty string
  ["", null],
  [null, null],
  ["   ", null],
  ["not-an-email", null],
  ["@nolocal.com", null],
  ["nodomain@", null],
];

export const DOMAIN_VECTORS: Array<[string | null, string | null]> = [
  ["https://www.experthvacservices.com", "experthvacservices.com"],
  ["http://experthvacservices.com/", "experthvacservices.com"],
  ["EXPERTHVAC.COM", "experthvac.com"],
  ["www.acme-plumbing.net", "acme-plumbing.net"],
  ["https://acme.com/services?utm_campaign=gmb#top", "acme.com"],
  ["https://acme.com:8443/x", "acme.com"],
  ["https://user:pw@acme.com/x", "acme.com"],
  ["acme.com.", "acme.com"],
  ["  https://WWW.Acme.COM/  ", "acme.com"],
  // Matches the Auto-Receptionist repo's domainKey(), which is the join key
  // for demo ingest.
  ["http://www.kappa-air.com", "kappa-air.com"],
  ["", null],
  [null, null],
  ["   ", null],
];

export const PHONE_VECTORS: Array<[string | null, string | null]> = [
  ["(602) 555-0142", "+16025550142"],
  ["602-555-0142", "+16025550142"],
  ["6025550142", "+16025550142"],
  ["+1 602 555 0142", "+16025550142"],
  ["1-602-555-0142", "+16025550142"],
  ["+1 (602) 555.0142", "+16025550142"],

  // NANP area/exchange codes never begin with 0 or 1, so these are junk that
  // merely happens to have the right digit count.
  ["0025550142", null],
  ["1025550142", null],
  ["11025550142", null],

  ["", null],
  [null, null],
  ["555-0142", null], // too short
  ["+44 20 7946 0958", null], // out of scope; null beats a wrong guess
  ["ext. 4021", null],
];
