import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * #268 AC7, #791: `agboss studio` end to end, as a user runs it — the LangGraph dev server started
 * on `@langchain/langgraph-api` (no `@langchain/langgraph-cli`), serving the application's graphs
 * until it is stopped.
 */

const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
const main = join(cliRoot, "src/cli/main.ts");

const folders: string[] = [];
afterEach(() => {
  for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A port nobody listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "localhost", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `GET /ok` answers 200 within `timeout` ms. */
async function untilUp(base: string, timeout: number, hasExited: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout && !hasExited()) {
    const ok = await fetch(`${base}/ok`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return;
    await pause(250);
  }
  throw new Error(`the Studio server did not answer at ${base}`);
}

const APPLICATION = `import {
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

@WorkflowStart({ name: "echo-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class EchoWorkflowStart {}

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
    start(EchoWorkflowStart)
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

describe("#268 AC7, #791: agboss studio end to end", () => {
  it("starts the LangGraph server for the project, serves each workflow's graph, stops on SIGTERM", async () => {
    // inside the CLI package (git-ignored), so `@agboss/core` resolves to the built framework
    const parent = join(cliRoot, ".scaffold-tmp");
    mkdirSync(parent, { recursive: true });
    const projectDir = mkdtempSync(join(parent, "studio-"));
    folders.push(projectDir);
    mkdirSync(join(projectDir, "src"));
    const application = join(projectDir, "src/echo.application.ts");
    writeFileSync(application, APPLICATION);
    const port = await freePort();
    const base = `http://localhost:${String(port)}`;

    let output = "";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", main, "studio", "--application", application, "--port", String(port)],
      {
        cwd: projectDir,
        // BROWSER=none: no Studio tab opened, as with langgraphjs dev
        env: { ...process.env, NO_COLOR: "1", BROWSER: "none" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    let hasExited = false;
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => {
        hasExited = true;
        resolve(code);
      }),
    );
    let graphNodes: readonly string[] = [];
    try {
      await untilUp(base, 90_000, () => hasExited);
      const assistants = (await (
        await fetch(`${base}/assistants/search`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ graph_id: "echo-workflow" }),
        })
      ).json()) as readonly { assistant_id: string; graph_id: string }[];
      const assistant = assistants.find((one) => one.graph_id === "echo-workflow");
      if (assistant === undefined) throw new Error(`no echo-workflow assistant:\n${output}`);
      const graph = (await (
        await fetch(`${base}/assistants/${assistant.assistant_id}/graph`)
      ).json()) as { nodes: readonly { id: string }[] };
      graphNodes = graph.nodes.map((node) => node.id);
    } finally {
      child.kill("SIGTERM");
    }

    expect(await exited, output).toBe(0);
    expect(graphNodes).toEqual(expect.arrayContaining(["echo-action"]));
    expect(output).toContain("studio: .agboss/langgraph.json — echo-workflow");
    expect(readFileSync(join(projectDir, ".agboss/.gitignore"), "utf8")).toContain(
      ".langgraph_api",
    );
    // the server stopped with it: the port is free again
    const isStillUp = await fetch(`${base}/ok`).then(
      () => true,
      () => false,
    );
    expect(isStillUp).toBe(false);
  }, 150_000);
});
