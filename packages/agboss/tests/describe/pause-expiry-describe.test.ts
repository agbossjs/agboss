/**
 * #941 AC1: `agboss describe` prints `expiresIn` per role, per question step and per tool.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describedChannelsOf } from "../../src/describe/channels.js";
import { describeApplication } from "../../src/describe/describe-application.js";
import { durationLabel } from "../../src/units/duration-label.js";
import { AgentExpiryApplication } from "../flow/fixtures/agent-expiry.fixture.js";
import { PublicExpiryApplication } from "../flow/fixtures/expiry-public.fixture.js";

describe("#941 AC1: describe shows the deadlines", () => {
  it("a role's expiresIn is data and a line's `expires in`", async () => {
    const assembled = await applicationOf(AgentExpiryApplication);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "expiring-refund-approval",
    );

    expect(channel?.expiresIn).toBe(24 * 3_600_000);
    expect(describeApplication(assembled).join("\n")).toContain(
      "expiring-refund-approval (RefundApprovalRole): AgentRefundDto → ToolCallApprovalDecisionDto · answered by the channel · expires in 24 h",
    );
  });

  it("a tool's expiresIn is on its line", async () => {
    const text = describeApplication(await applicationOf(AgentExpiryApplication)).join("\n");

    expect(text).toMatch(
      /urgent-refund-tool \(channel:expiring-refund-approval[^\n]*· expires in 4 h/,
    );
    expect(text).not.toMatch(/\nexpiring-refund-tool[^\n]*expires in/);
  });

  it("a question step's expiresIn is in the flow", async () => {
    const text = describeApplication(await applicationOf(PublicExpiryApplication)).join("\n");

    expect(text).toContain(".toQuestion(ManagerQuestion, { expiresIn: 14400000 })");
    expect(text).toContain("toQuestion(DirectorQuestion, { expiresIn: 3600000 })");
  });

  it("durations read as people write them", () => {
    expect([86_400_000, 5_400_000, 90_000, 30_000, 1500].map(durationLabel)).toEqual([
      "24 h",
      "90 min",
      "90 s",
      "30 s",
      "1500 ms",
    ]);
  });
});
