/**
 * #941 AC1: `agboss describe` prints the timeout of each pause target.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describedChannelsOf } from "../../src/describe/channels.js";
import { describeAssembledApplication } from "../../src/describe/describe-application.js";
import { durationLabel } from "../../src/units/duration-label.js";
import { AgentExpiryApplication } from "../flow/fixtures/agent-expiry.fixture.js";
import { PublicExpiryApplication } from "../flow/fixtures/expiry-public.fixture.js";

describe("#941 AC1: describe shows the deadlines", () => {
  it("a target's timeout is data and a line's `expires in`", async () => {
    const assembled = await applicationOf(AgentExpiryApplication);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "expiring-refund-approval-tool-approval",
    );

    expect(channel?.expiresIn).toBe(24 * 3_600_000);
    expect(describeAssembledApplication(assembled).join("\n")).toContain(
      "expiring-refund-approval-tool-approval (RefundApprovalToolApproval): AgentRefundDto → ToolCallApprovalDecisionDto · answered by the channel · expires in 24 h",
    );
  });

  it("a tool's approval carries its own timeout: urgent 4 h, the others 24 h", async () => {
    const text = describeAssembledApplication(await applicationOf(AgentExpiryApplication)).join(
      "\n",
    );

    expect(text).toMatch(
      /urgent-refund-tool-approval \(UrgentRefundToolApproval\)[^\n]*expires in 4 h/,
    );
    expect(text).toMatch(/\n +· urgent-refund-tool \(approval:urgent-refund-tool-approval,/);
  });

  it("a step's own target is in the flow", async () => {
    const text = describeAssembledApplication(await applicationOf(PublicExpiryApplication)).join(
      "\n",
    );

    expect(text).toContain(".toExternalTask(ShortManagerExternalTask)");
    expect(text).toContain("toExternalTask(HourDirectorExternalTask)");
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
