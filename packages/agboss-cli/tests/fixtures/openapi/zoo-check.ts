/**
 * A hand-written test dropped into the generated project: the agent's model calls two generated
 * OpenAPI tools through `testWith`, and the stubbed API records what reached it.
 */
export const ZOO_CHECK = `import { callTool, replyWith, routeTo, testWith } from "@agboss/core/testing";
import { afterEach, expect, vi } from "vitest";
import { KeeperAgent } from "../../../src/agents/keeper/keeper.agent.js";
import { MainRouter } from "../../../src/routers/main/main.router.js";
import { CreatePetTool } from "../../../src/tools/create-pet.tool.js";
import { GetPetTool } from "../../../src/tools/get-pet.tool.js";
import { TextWorkflowFinish } from "../../../src/workflows/zoo/text.workflow-finish.js";
import { TextWorkflowStart } from "../../../src/workflows/zoo/text.workflow-start.js";
import { ZooApplication } from "../../../src/zoo.application.js";

const test = testWith(ZooApplication);

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the OpenAPI tools send the method, path, query and body", async ({ app, mockLlm }) => {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, body: init.body });
    return Promise.resolve(new Response(JSON.stringify({ id: 42, name: "Rex", kind: "dog" })));
  });
  // one route: the router decides without its model (#262: a second routeTo would not compile)
  mockLlm(MainRouter).thenReturnAlways(routeTo(KeeperAgent));
  mockLlm(KeeperAgent).thenReturn(
    callTool(GetPetTool, { id: 42, days: 7, fields: ["name", "kind"] }),
    callTool(CreatePetTool, { body: { name: "Rex", kind: "dog", owner: { email: "a@b.co" } } }),
    replyWith("Done."),
  );

  const result = await app.execute(TextWorkflowStart, { text: "Show pet 42, then add Rex" });

  expect(result).toFinishWith(TextWorkflowFinish, { text: "Done." });
  expect(calls).toEqual([
    {
      url: "https://pets.example.com/v1/pets/42?days=7&fields=name&fields=kind",
      method: "GET",
      body: undefined,
    },
    {
      url: "https://pets.example.com/v1/pets",
      method: "POST",
      body: JSON.stringify({ name: "Rex", kind: "dog", owner: { email: "a@b.co" } }),
    },
  ]);
});
`;
