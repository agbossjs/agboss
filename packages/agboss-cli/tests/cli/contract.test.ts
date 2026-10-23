import { describe, expect, it } from "vitest";
import { COMMANDS } from "../../src/cli/commands.js";
import { envelope, fixture, agboss } from "./agboss.js";

const WORKFLOW = fixture("test-workflow/test.workflow.ts");
const commands = Object.keys(COMMANDS).filter((name) => name !== "help");

interface Described {
  readonly name: string;
  readonly options: readonly { readonly flag: string; readonly required: boolean }[];
  readonly commonOptions: readonly { readonly flag: string }[];
  /** A command made of subcommands (#396: `eval run | score`): each one described the same way. */
  readonly subcommands?: readonly Described[];
}

describe("#198 AC1: every command has --help and a --json description", () => {
  it.each(commands)("agboss %s --help prints its options and exits 0", async (name) => {
    const call = await agboss([name, "--help"]);

    expect(call).toMatchObject({ code: 0, stderr: "" });
    expect(call.stdout).toContain(`agboss ${name} — ${COMMANDS[name]?.summary ?? ""}`);
    expect(call.stdout).toMatch(/--json\s+machine output/);
    for (const option of COMMANDS[name]?.options ?? [])
      expect(call.stdout).toContain(`--${option.name}`);
  });

  it.each(commands)(
    "agboss help %s --json and agboss %s --help --json describe it",
    async (name) => {
      const viaHelp = envelope(await agboss(["help", name, "--json"]));
      const viaFlag = envelope(await agboss([name, "--help", "--json"]));

      expect(viaFlag).toEqual(viaHelp);
      expect(viaHelp).toMatchObject({ schema: 1, ok: true, command: "help", warnings: [] });
      const described = viaHelp.result as Described;
      expect(described.name).toBe(name);
      expect(described.options.map((o) => o.flag)).toEqual(
        (COMMANDS[name]?.options ?? []).map((o) => `--${o.name}`),
      );
      expect(described.commonOptions.map((o) => o.flag)).toEqual(["--json", "--debug", "--help"]);
    },
  );

  it("#268 AC1, AC2, AC8: every command but create, migrate and help takes --application; the run commands --start", async () => {
    const all = envelope(await agboss(["help", "--json"])).result as Described[];
    const takes = (c: Described, flag: string): boolean =>
      c.options.some((o) => o.flag === flag) ||
      (c.subcommands ?? []).some((sub) => takes(sub, flag));
    const taking = (flag: string): string[] => all.filter((c) => takes(c, flag)).map((c) => c.name);

    expect(all.map((c) => c.name)).toEqual(Object.keys(COMMANDS));
    expect(taking("--start")).toEqual(["chat", "run", "eval", "replay", "golden", "compare"]);
    expect(
      all.map((c) => c.name).filter((name) => !taking("--application").includes(name)),
    ).toEqual(["create", "migrate", "help"]);
    // generate's --workflow is a workflow's full name, found in the application (#268 AC8)
    expect(taking("--workflow")).toEqual(["generate"]);
  });

  it("agboss describe --json: every workflow of the application as data, only the envelope on stdout", async () => {
    const call = await agboss(["describe", "--application", WORKFLOW, "--json"]);

    expect(call.code).toBe(0);
    const { application, workflows } = envelope(call).result as {
      application: { name: string };
      workflows: {
        name: string;
        agents: { name: string; tools: string[] }[];
        routers: { name: string }[];
      }[];
    };
    expect(application.name).toBe("test-application");
    const [result] = workflows;
    expect(result?.name).toBe("test-workflow");
    expect(result?.agents).toEqual([
      expect.objectContaining({ name: "coder-agent", tools: [] }),
      expect.objectContaining({ name: "researcher-agent", tools: ["current-time-tool"] }),
    ]);
    expect(result?.routers.map((r) => r.name)).toEqual(["main-router"]);
  });

  it("#266 AC2: agboss describe --json gives each model with the provider it resolves to", async () => {
    const call = await agboss(["describe", "--application", WORKFLOW, "--json"]);

    const { workflows } = envelope(call).result as {
      workflows: { models: { key: string; model: string; provider: string }[] }[];
    };
    expect(workflows[0]?.models).toContainEqual({
      key: "routers.main-router",
      model: "typesafe/jev-1.13",
      provider: "decisions-model-provider",
    });
  });

  it("agboss describe without --json still prints the text", async () => {
    const call = await agboss(["describe", "--application", WORKFLOW]);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain("test-workflow 1.0.0");
    expect(call.stdout).toContain("agents");
  });
});
