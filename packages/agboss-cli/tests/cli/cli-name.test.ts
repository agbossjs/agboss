/**
 * #268 AC12: the command is `agboss` — in every command's usage and help, in the scripts and the
 * README a new project gets, and in what `generate` writes; generated code names parts by their
 * full names, as `agboss` takes them.
 */
import { describe, expect, it } from "vitest";
import { COMMANDS, helpFor, usage } from "../../src/cli/usage.js";
import { specFromFlags } from "../../src/scaffold/flags.js";
import type { WorkflowSpec } from "../../src/scaffold/plan.js";
import { planProject } from "../../src/scaffold/project.js";

/** A command line in a text: `agboss <command>`, `npx agboss <command>` — not `npm run <script>`. */
const COMMAND_LINE =
  /(?:^|\s|`|")(?:npx )?(?<!npm )([a-z][\w-]*) (chat|describe|check|generate|create|rag|dev|studio|eval|golden|compare)\b/gm;

const project = planProject(specFromFlags("desk", { yes: true }) as WorkflowSpec);

describe("#268 AC12: the command is agboss", () => {
  it("every command's usage and help name agboss", () => {
    for (const [name, command] of Object.entries(COMMANDS)) {
      expect(command.usage.startsWith(`agboss ${name}`), command.usage).toBe(true);
      expect(helpFor(name)).toContain(`Usage: agboss ${name}`);
    }
    expect(usage()).toContain("Usage: agboss <command> [options]");
  });

  it("a new project's scripts and README call agboss, by full names", () => {
    const text = (path: string): string =>
      project.find((file) => file.path === path)?.content ?? "";
    const scripts = (JSON.parse(text("package.json")) as { scripts: Record<string, string> })
      .scripts;

    const commands = [...Object.values(scripts), text("README.md")].flatMap((line) =>
      [...line.matchAll(COMMAND_LINE)].map((match) => match[1]),
    );
    expect(commands.length).toBeGreaterThan(5);
    expect(new Set(commands)).toEqual(new Set(["agboss"]));
    expect(text("README.md")).toContain(
      "npx agboss generate agent billing-agent --workflow desk-workflow",
    );
  });
});
