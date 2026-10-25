import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planGenerate } from "../../src/scaffold/generate.js";
import { workflowDeclaration, writeApplication } from "./application-fixture.js";

/** #279 S77 i: `agboss generate arbiter` writes a code arbiter for the agents of a launch. */

const AGENT = (name: string, id: string) =>
  `@Agent({ name: "${id}", description: "x" })\nexport class ${name} {}\n`;

/** A project whose workflow launches `launches` (each a list of agent classes). */
function projectWith(launches: readonly (readonly string[])[]): string {
  const root = mkdtempSync(join(tmpdir(), "agboss-arbiter-"));
  mkdirSync(join(root, "src/review/agents"), { recursive: true });
  const agents = [...new Set(launches.flat())];
  for (const agent of agents) {
    const id = agent.replace(/Agent$/, "").toLowerCase();
    writeFileSync(join(root, `src/review/agents/${id}.agent.ts`), AGENT(agent, `${id}-agent`));
  }
  const imports = agents
    .map((agent) => {
      const id = agent.replace(/Agent$/, "").toLowerCase();
      return `import { ${agent} } from "./agents/${id}.agent.js";`;
    })
    .join("\n");
  const paths = launches
    .map((launch) => `start(S).toParallelAgents(${launch.join(", ")}).joinQuorum({ min: 1 })`)
    .join(",\n");
  const review = {
    module: "src/review/review.workflow.ts",
    className: "Review",
    name: "review-workflow",
  };
  writeApplication(root, review);
  writeFileSync(
    join(root, review.module),
    `${imports}\nflow: [\n${paths}\n]\n${workflowDeclaration(review)}`,
  );
  return root;
}

const options = { workflow: "review-workflow" };

describe("#279: agboss generate arbiter", () => {
  it("one @OnAnswer method per distinct agent of the launch, named from<Agent>", async () => {
    const root = projectWith([["ScoreAAgent", "CriticAgent", "CriticAgent"]]);

    const { create, modify } = await planGenerate("arbiter", "valid-score-arbiter", options, root);

    expect(modify).toEqual([]);
    const [file] = create;
    expect(file?.path).toBe("src/review/arbiters/valid-score/valid-score.arbiter.ts");
    expect(file?.content).toContain('name: "valid-score-arbiter"');
    expect(file?.content).toContain("decidedBy: DecidedBy.Code");
    expect(file?.content).toContain("export class ValidScoreArbiter {");
    expect(file?.content).toContain('import { ScoreAAgent } from "../../agents/scorea.agent.js";');
    expect(file?.content).toContain(
      "  @OnAnswer(ScoreAAgent)\n  fromScoreA(answer: ArbiterAnswerOf<typeof ScoreAAgent>): boolean {",
    );
    expect(file?.content.match(/@OnAnswer\(CriticAgent\)/g)).toHaveLength(1);
  });

  it("several launches: --agent names the one to judge", async () => {
    const root = projectWith([["ScoreAAgent"], ["CriticAgent", "AuditAgent"]]);

    await expect(planGenerate("arbiter", "pick-arbiter", options, root)).rejects.toThrow(
      "has 2 agents' launches — name one of its agents with --agent <full name>",
    );
    const { create } = await planGenerate(
      "arbiter",
      "pick-arbiter",
      { ...options, agent: "audit-agent" },
      root,
    );
    expect(create[0]?.content).toContain("fromCritic(");
    expect(create[0]?.content).toContain("fromAudit(");
    expect(create[0]?.content).not.toContain("fromScoreA(");
  });

  it("a workflow without an agents' launch has nothing to judge", async () => {
    const root = projectWith([]);

    await expect(planGenerate("arbiter", "pick-arbiter", options, root)).rejects.toThrow(
      "has no .toParallelAgents(…) launch to judge",
    );
  });

  it("#268 AC8: --agent takes the full name; a short one is not guessed", async () => {
    const root = projectWith([["ScoreAAgent"], ["CriticAgent", "AuditAgent"]]);

    await expect(
      planGenerate("arbiter", "pick-arbiter", { ...options, agent: "audit" }, root),
    ).rejects.toThrow(
      'Agent "audit" not found in src/review/review.workflow.ts. Did you mean "audit-agent"?',
    );
  });
});
