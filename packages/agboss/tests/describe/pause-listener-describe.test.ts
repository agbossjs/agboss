/**
 * #940: `agboss describe` lists the application's pause listeners and says which is trusted with
 * the ids of channel pauses (`allowAnswering`); an application without any prints no such line.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { applicationLines, describedApplicationOf } from "../../src/describe/application.js";
import { PausesApplication } from "../channels/fixtures/pauses.workflow.js";
import { PlainProbeApplication } from "../health/fixtures/health.application.js";

describe("#940: describe lists the pause listeners", () => {
  it("each listener by name, the trusted one marked", async () => {
    const described = describedApplicationOf(await applicationOf(PausesApplication));

    expect(described.pauseListeners).toEqual([
      { name: "audit-pause-listener", allowAnswering: false },
      { name: "trusted-pause-listener", allowAnswering: true },
    ]);
    expect(applicationLines(described)).toContain(
      "pause listeners audit-pause-listener, trusted-pause-listener (allowAnswering: sees the ids of channel pauses)",
    );
  });

  it("an application with none prints no line", async () => {
    const described = describedApplicationOf(await applicationOf(PlainProbeApplication));

    expect(described.pauseListeners).toEqual([]);
    expect(applicationLines(described).some((line) => line.startsWith("pause listeners"))).toBe(
      false,
    );
  });
});
