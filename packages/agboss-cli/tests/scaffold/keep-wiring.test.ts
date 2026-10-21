import { describe, expect, it } from "vitest";
import { keepWiring } from "../../src/scaffold/keep-wiring.js";

const path = "src/desk/routers/main.router.ts";
const router = (imports: string, routes: string): string => `import { Router } from "agboss";
${imports}
@Router({
  name: "main",
  description: "Picks",
  routes: [${routes}],
})
export class MainRouter {}
`;

describe("#237: keepWiring", () => {
  it("keeps the old elements first, adds the template's new ones, carries their imports", () => {
    const old = router(
      'import { BillingAgent } from "../agents/billing.agent.js";\nimport { Finish } from "../finish.js";',
      '{ prompt: "Bills", target: BillingAgent }, { prompt: "Stop", target: Finish }',
    );
    const regenerated = router(
      'import { Finish } from "../finish.js";\nimport { HelpAgent } from "../agents/help.agent.js";',
      '{ prompt: "Help", target: HelpAgent }, { prompt: "Stop now", target: Finish }',
    );

    const { file, kept } = keepWiring(old, { path, content: regenerated });

    expect(kept).toEqual([`${path}: routes [BillingAgent]`]);
    expect(file.content).toContain(
      'routes: [{ prompt: "Bills", target: BillingAgent }, { prompt: "Stop", target: Finish }, { prompt: "Help", target: HelpAgent }]',
    );
    expect(file.content).toContain('import { BillingAgent } from "../agents/billing.agent.js";');
    expect(file.content.match(/import \{ Finish \}/g)).toHaveLength(1);
  });

  it("a property the template does not write is added back; nothing lost → the file as generated", () => {
    const agent = (extra: string): string =>
      `import { Agent } from "agboss";\nimport { Grounded } from "../judges/grounded.judge.js";\n@Agent({\n  name: "a",\n  tools: [],${extra}\n})\nexport class A {}\n`;
    const regenerated = { path: "a.agent.ts", content: agent("") };

    const { file, kept } = keepWiring(agent("\n  judges: [Grounded],"), regenerated);
    expect(kept).toEqual(["a.agent.ts: judges [Grounded]"]);
    expect(file.content).toContain("judges: [Grounded]");

    expect(keepWiring(agent(""), regenerated)).toEqual({ file: regenerated, kept: [] });
  });

  it("deps it cannot keep (the constructor is rewritten) → a conflict naming them", () => {
    const tool = (deps: string): string =>
      `@Tool({\n  name: "t-tool",${deps}\n})\nexport class T {}\n`;
    expect(() =>
      keepWiring(tool("\n  deps: [ApiService],"), { path: "t.tool.ts", content: tool("") }),
    ).toThrow("t.tool.ts: deps [ApiService] cannot be kept");
  });
});
