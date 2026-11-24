import { beforeEach, describe, expect } from "vitest";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  OnboardApplication,
  OnboardedFinish,
  OnboardStart,
  onboarding,
  TurnedAwayFinish,
} from "./fixtures/on-finish.workflow.js";

const test = testWith(OnboardApplication);

beforeEach(() => {
  onboarding.length = 0;
});

describe("#1275b: .onFinish(ChildFinish, …) picks the path by the finish the child ended at", () => {
  test("three finishes, two of them giving one DTO, each take their own path", async ({ app }) => {
    const ok = await execute(app, OnboardStart, { customer: "ann", found: "ok" });
    const fraud = await execute(app, OnboardStart, { customer: "bob", found: "fraud" });
    const lapsed = await execute(app, OnboardStart, { customer: "cy", found: "expired" });

    expect(ok).toFinishWith(OnboardedFinish, { account: "opened" });
    expect(fraud).toFinishWith(TurnedAwayFinish, { told: "blocked" });
    expect(lapsed).toFinishWith(TurnedAwayFinish, { told: "come back" });
    expect(onboarding).toEqual(["open", "block", "retry"]);
  });
});
