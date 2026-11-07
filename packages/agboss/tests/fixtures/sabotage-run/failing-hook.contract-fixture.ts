// #831: a sabotage fixture whose hook fails: every case fails for that, not for a rule it breaks.
import { beforeAll, describe, expect, it } from "vitest";

describe("a set whose database is down", () => {
  beforeAll(() => {
    throw new Error("cannot connect");
  });
  it("a rule", () => {
    expect(true).toBe(true);
  });
});
