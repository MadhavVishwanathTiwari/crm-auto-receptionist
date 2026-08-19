import { describe, expect, it } from "vitest";

import {
  operatorFor,
  operatorIndex,
  operatorNames,
  type OperatorGroup,
} from "@/lib/dashboard/operators";

// The shape dashboard_activity() returns: app.operator_aliases already
// collapsed in SQL, because it is revoked from `authenticated` and has no API
// path for TypeScript to read.
const GROUPS: OperatorGroup[] = [
  {
    operator: "madhav",
    user_ids: ["user-madhav-io", "user-madhav-try"],
    emails: ["madhav@autoreceptionist.io", "madhav@tryautoreceptionist.com"],
  },
  {
    operator: "ojas",
    user_ids: ["user-ojas"],
    emails: ["ojas@getautoreceptionist.com"],
  },
];

describe("operatorIndex", () => {
  it("collapses two accounts onto one operator", () => {
    // The whole point. A strict userId comparison would report madhav twice and
    // split his numbers across two rows nobody could add up.
    const index = operatorIndex(GROUPS);
    expect(index.get("user-madhav-io")).toBe("madhav");
    expect(index.get("user-madhav-try")).toBe("madhav");
    expect(index.size).toBe(3);
  });

  it("survives a group with no accounts", () => {
    // An operator whose address has an alias row but who has never signed in
    // has no auth user, so the roster can carry an empty user_ids array.
    const index = operatorIndex([{ operator: "nobody", user_ids: [], emails: [] }]);
    expect(index.size).toBe(0);
  });
});

describe("operatorFor", () => {
  const index = operatorIndex(GROUPS);

  it("resolves either of an operator's accounts", () => {
    expect(operatorFor("user-madhav-try", index)).toBe("madhav");
  });

  it("is null for the unclaimed pool", () => {
    // Not a bucket called "unknown": an unclaimed lead is work nobody has
    // picked up, not somebody's poor week, and the dashboard counts it apart.
    expect(operatorFor(null, index)).toBeNull();
  });

  it("is null for an account in no group", () => {
    expect(operatorFor("user-stranger", index)).toBeNull();
  });
});

describe("operatorNames", () => {
  it("is alphabetical, so a column does not move between renders", () => {
    expect(operatorNames(GROUPS)).toEqual(["madhav", "ojas"]);
  });
});
