import { expect, it } from "vitest";
import { testGuardrail } from "@agboss/core/testing";
import { NoCredentialsGuardrail } from "../../../../src/desk/guardrails/no-credentials/no-credentials.guardrail.js";

it("testGuardrail: a code guardrail takes no model; a block is an output", async () => {
  const check = testGuardrail(NoCredentialsGuardrail);

  const blocked = await check("my password is hunter2", { element: "desk-agent" });
  const passed = await check("where is #7?", { element: "desk-agent" });

  expect(blocked.output).toMatchObject({ isBlocked: true });
  expect(passed.output).toMatchObject({ isBlocked: false });
});
