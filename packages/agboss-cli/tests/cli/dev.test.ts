import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCommandOf, watchedFolderOf } from "../../src/cli/dev.js";

/** #268 AC6: `agboss dev` regenerates the types on change; the watch loop itself is watch.test.ts. */

const folders: string[] = [];
const folderIn = (parent: string, prefix: string): string => {
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, prefix));
  folders.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Resolves once `check` holds, polling every 20 ms; fails after `timeout` ms. */
async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("#268 AC6: what a pass runs", () => {
  it("watches the application's src/, else the application's folder", () => {
    expect(watchedFolderOf("/p/src/desk/desk.application.ts")).toBe("/p/src");
    expect(watchedFolderOf("/p/desk.application.ts")).toBe("/p");
  });

  it("agboss check in a child: this Node, this CLI, the application by path, --env and --strict", () => {
    const entry = { execArgv: ["--import", "tsx"], script: "/cli/main.ts" };

    expect(
      checkCommandOf(entry, { file: "/p/src/a.application.ts", env: undefined, strict: false }),
    ).toEqual({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "/cli/main.ts",
        "check",
        "--application",
        "/p/src/a.application.ts",
      ],
    });
    expect(checkCommandOf(entry, { file: "/a.ts", env: "prod", strict: true }).args).toEqual([
      "--import",
      "tsx",
      "/cli/main.ts",
      "check",
      "--application",
      "/a.ts",
      "--env",
      "prod",
      "--strict",
    ]);
  });
});

// ── end to end: `agboss dev` as a user runs it, on a project of its own ──

const cliRoot = new URL("../..", import.meta.url).pathname;
const main = join(cliRoot, "src/cli/main.ts");

/** An application of one workflow, its start named `<start>-workflow-start`; imports the package. */
const applicationSource = (start: string): string => `import {
  Action,
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  start,
} from "@agboss/core";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "@agboss/core/dto";
import { usd } from "@agboss/core/units";

@WorkflowStart({ name: "${start}-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class MessageWorkflowStart {}

@Action({
  name: "echo-action",
  description: "Answers the message with itself",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
export class EchoAction {
  execute(input) {
    return Promise.resolve({ text: input.message.value.text });
  }
}

@WorkflowFinish({ name: "echo-workflow-finish", description: "The echo", output: WorkflowFinishTextDto })
export class EchoWorkflowFinish {}

@Workflow({
  name: "echo-workflow",
  version: "1.0.0",
  flow: [
    start(MessageWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(EchoAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(EchoWorkflowFinish),
  ],
})
export class EchoWorkflow {}

@Budget({ name: "application-daily-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class ApplicationDailyBudget {
  maxSpend() {
    return usd(1);
  }
}

@Budget({ name: "tenant-daily-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class TenantDailyBudget {
  maxSpend() {
    return usd(1);
  }
}

@Budget({ name: "execution-budget", scope: BudgetScope.Execution })
export class ExecutionBudget {
  maxSpend() {
    return usd(0.05);
  }
}

@Application({
  name: "echo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EchoWorkflow],
  budgets: [ApplicationDailyBudget, TenantDailyBudget, ExecutionBudget],
})
export class EchoApplication {}
`;

describe("#268 AC6: agboss dev end to end", () => {
  it("regenerates .agboss/types.d.ts when a source changes, until it is stopped", async () => {
    // inside the CLI package (git-ignored), so `agboss` resolves to the built framework
    const projectDir = folderIn(join(cliRoot, ".scaffold-tmp"), "dev-");
    const application = join(projectDir, "src/echo.application.ts");
    mkdirSync(join(projectDir, "src"));
    writeFileSync(application, applicationSource("first"));
    const types = join(projectDir, ".agboss/types.d.ts");
    const typesHave = (text: string) => (): boolean =>
      existsSync(types) && readFileSync(types, "utf8").includes(text);

    let output = "";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", main, "dev", "--application", application],
      {
        cwd: projectDir,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await until(typesHave('"first-workflow-start"'), 60_000);
      // written again every 2 s until the types follow (#878): under heavy file churn the
      // watcher may not report one write
      let writtenAt = 0;
      await until(() => {
        if (typesHave('"second-workflow-start"')()) return true;
        if (Date.now() - writtenAt > 2_000) {
          writeFileSync(application, applicationSource("second"));
          writtenAt = Date.now();
        }
        return false;
      }, 60_000);
    } finally {
      child.kill("SIGTERM");
    }

    expect(await exited).toBe(0);
    expect(output).toContain("dev: watching src — Ctrl+C to stop");
    expect(output).toContain("dev: changed echo.application.ts");
    expect(readFileSync(types, "utf8")).not.toContain('"first-workflow-start"');
  }, 120_000);
});
