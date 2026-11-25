/**
 * #942: `agboss describe` prints a role's `remindBefore` — as data and on the channel's line.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describedChannelsOf } from "../../src/describe/channels.js";
import { describeAssembledApplication } from "../../src/describe/describe-application.js";
import { ExtensionApplication } from "../flow/fixtures/pause-extension.fixture.js";

describe("#942: describe shows the reminder", () => {
  it("a role's remindBefore is data and a line's `reminds 2 h before`", async () => {
    const assembled = await applicationOf(ExtensionApplication);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "extendable-manager-external-task",
    );

    expect(channel).toMatchObject({ expiresIn: 24 * 3_600_000, remindBefore: 2 * 3_600_000 });
    expect(describeAssembledApplication(assembled).join("\n")).toContain(
      "· expires in 24 h · reminds 2 h before",
    );
  });

  it("a target with a reminder and a long timeout says the reminder after it", async () => {
    const assembled = await applicationOf(ExtensionApplication);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "extendable-open-external-task",
    );

    expect(channel?.expiresIn).toBeGreaterThan(24 * 3_600_000);
    expect(channel?.remindBefore).toBe(2 * 3_600_000);
    expect(describeAssembledApplication(assembled).join("\n")).toMatch(
      /extendable-open-external-task \(ExtendOpenExternalTask\)[^\n]*answered by the channel · expires in [^\n]*reminds 2 h before/,
    );
  });
});
