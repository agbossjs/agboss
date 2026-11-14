/**
 * #942: `agboss describe` prints a role's `remindBefore` — as data and on the channel's line.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describedChannelsOf } from "../../src/describe/channels.js";
import { describeApplication } from "../../src/describe/describe-application.js";
import { ExtensionApplication } from "../flow/fixtures/pause-extension.fixture.js";

describe("#942: describe shows the reminder", () => {
  it("a role's remindBefore is data and a line's `reminds 2 h before`", async () => {
    const assembled = await applicationOf(ExtensionApplication);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "extendable-manager-question",
    );

    expect(channel).toMatchObject({ expiresIn: 24 * 3_600_000, remindBefore: 2 * 3_600_000 });
    expect(describeApplication(assembled).join("\n")).toContain(
      "· expires in 24 h · reminds 2 h before",
    );
  });

  it("a role with a reminder and no deadline of its own says only the reminder", async () => {
    const assembled = await applicationOf(ExtensionApplication);

    const channel = describedChannelsOf(assembled).find(
      (one) => one.name === "extendable-open-question",
    );

    expect(channel?.expiresIn).toBeUndefined();
    expect(channel?.remindBefore).toBe(2 * 3_600_000);
    expect(describeApplication(assembled).join("\n")).toMatch(
      /extendable-open-question \(ExtendOpenQuestion\)[^\n]*answered by the channel · reminds 2 h before/,
    );
  });
});
