/**
 * #1150 (acceptance H): every PII policy that reaches a child's models by inheritance is in the
 * `configHash` of the root that launches it — the application's and each ancestor's `@Workflow`
 * list, also on a workflow with no agent or router of its own — while the child's own hash stays
 * "as declared". So a tree paused inside the child is not resumed blindly under a changed policy
 * (`IncompatibleResumeError`), and a deployment that changed nothing resumes it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { createAppDeps, type AppDeps } from "../../src/app/app-deps.js";
import { ownDepsOf } from "../../src/app/own-deps.js";
import type { Class } from "../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { joinKeysOf } from "../../src/flow/runtime/workflow-keys.js";
import {
  Agent,
  EmptyEnvironment,
  IncompatibleResumeError,
  PiiAction,
  PiiFileAction,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type PiiMatch,
  type PiiPolicyHandler,
  inline,
  Ttl,
} from "../../src/index.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { childSourcesIn, configSnapshot } from "../../src/run/versions.js";
import { versionOf } from "../../src/turns/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { answerOf, execute, onStart } from "../helpers/flow.js";
import {
  resetSharedDatabase,
  SharedCheckpointSaver,
  SharedExecutionRecordRepository,
  SharedPausedExecutionRepository,
} from "../helpers/shared-infrastructure.js";
import { SendEmail, sent } from "../app/fixtures/mail.workflow.js";

const none = (): readonly PiiMatch[] => [];

/** A policy by name and file action: two of one name are one policy changed between deployments. */
const policyOf = (name: string, files: PiiFileAction): Class => {
  @PiiPolicy({ name, action: PiiAction.mask(), files })
  class ChainPolicy implements PiiPolicyHandler {
    findMatches = none;
  }
  return ChainPolicy;
};

const AppAllow = policyOf("cr-app-pii-policy", PiiFileAction.AllowOriginal);
const AppMask = policyOf("cr-app-pii-policy", PiiFileAction.Mask);
const RootAllow = policyOf("cr-root-pii-policy", PiiFileAction.AllowOriginal);
const RootMask = policyOf("cr-root-pii-policy", PiiFileAction.Mask);
const OwnAllow = policyOf("cr-own-pii-policy", PiiFileAction.AllowOriginal);
const OwnMask = policyOf("cr-own-pii-policy", PiiFileAction.Mask);

@Agent({
  name: "cr-mailer-agent",
  description: "Sends the emails it is asked to",
  prompt: inline("Send the email you are asked to send."),
  tools: [SendEmail],
  model: "test/cr-mailer",
})
class CrMailer {}

@WorkflowStart({ name: "cr-child-workflow-start", description: "s", input: WorkflowStartTextDto })
class CrChildStart {}

@WorkflowFinish({
  name: "cr-child-workflow-finish",
  description: "f",
  output: WorkflowFinishTextDto,
})
class CrChildFinish {}

@WorkflowStart({ name: "cr-root-workflow-start", description: "s", input: WorkflowStartTextDto })
class CrRootStart {}

@WorkflowFinish({
  name: "cr-root-workflow-finish",
  description: "f",
  output: WorkflowFinishTextDto,
})
class CrRootFinish {}

/** What one deployment declares: the application's, the root's and the child's own lists. */
interface Policies {
  readonly application?: readonly Class[];
  readonly root?: readonly Class[];
  readonly own?: readonly Class[];
}

/** One deployment: a root with no agent of its own that launches the mailer child. */
function deployment({ application = [], root = [], own = [] }: Policies): {
  readonly app: Class;
  readonly root: Class;
} {
  @Workflow({
    name: "cr-child-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(CrChildStart).toAgent(CrMailer).toFinish(CrChildFinish)],
    piiPolicies: own,
  })
  class CrChild {}

  @Workflow({
    name: "cr-root-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(CrRootStart).toWorkflow(CrChild).toFinish(CrRootFinish)],
    piiPolicies: root,
  })
  class CrRoot {}

  @Application({
    name: "cr-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [CrRoot],
    providers: [
      SharedCheckpointSaver,
      SharedPausedExecutionRepository,
      SharedExecutionRecordRepository,
    ],
    budgets: TEST_BUDGETS,
    piiPolicies: application,
  })
  class CrApplication {}
  return { app: CrApplication, root: CrRoot };
}

/** The root's hash as `agboss describe` computes it: from the assembly, its children by class. */
async function describedHash(app: Class): Promise<string> {
  const { workflows } = await applicationOf(app);
  const [root] = workflows;
  return versionOf(configSnapshot(root ?? fail(), childSourcesIn(workflows)));
}

/** A root → a middle workflow with no agent, listing `middle` → the mailer child. */
function nested(middle: readonly Class[]): Class {
  @Workflow({
    name: "cr-leaf-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(CrChildStart).toAgent(CrMailer).toFinish(CrChildFinish)],
  })
  class CrLeaf {}

  @WorkflowStart({
    name: "cr-middle-workflow-start",
    description: "s",
    input: WorkflowStartTextDto,
  })
  class CrMiddleStart {}

  @WorkflowFinish({
    name: "cr-middle-workflow-finish",
    description: "f",
    output: WorkflowFinishTextDto,
  })
  class CrMiddleFinish {}

  @Workflow({
    name: "cr-middle-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(CrMiddleStart).toWorkflow(CrLeaf).toFinish(CrMiddleFinish)],
    piiPolicies: middle,
  })
  class CrMiddle {}

  @Workflow({
    name: "cr-root-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(CrRootStart).toWorkflow(CrMiddle).toFinish(CrRootFinish)],
  })
  class CrRoot {}

  @Application({
    name: "cr-nested-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [CrRoot],
    budgets: TEST_BUDGETS,
  })
  class CrNestedApplication {}
  return CrNestedApplication;
}

const scripted = (): ScriptBook => {
  const book = new ScriptBook();
  book
    .scriptOf("agent:cr-mailer-agent")
    .thenReturn(callTool(SendEmail, { to: "boss@example.com" }), replyWith("Sent."));
  return book;
};

/** Pauses inside the child on a deployment with `before`, then resumes on one with `after`. */
async function resumedAcross(before: Policies, after: Policies) {
  const book = scripted();
  const options = () => ({ processEnv: {}, gateway: createScriptedGateway(book) });
  const first = await createTestAppWith(deployment(before).app, options());
  const paused = await execute(first, CrRootStart, { text: "Email the boss" });
  await first.close();
  expect(paused.status).toBe(ExecutionStatus.Paused);
  expect(paused.pending[0]?.childExecutionId).toBeDefined();
  const next = await createTestAppWith(deployment(after).app, options());
  try {
    return await next.resume(answerOf(paused, { approved: true }));
  } finally {
    await next.close();
  }
}

beforeEach(() => {
  resetSharedDatabase();
  sent.length = 0;
});

describe("#1150: a policy a child inherits is in its root's configHash", () => {
  it("an application-level policy changed between pause and resume: refused, nothing sent", async () => {
    const resumed = resumedAcross({ application: [AppAllow] }, { application: [AppMask] });

    await expect(resumed).rejects.toBeInstanceOf(IncompatibleResumeError);
    expect(sent).toEqual([]);
  });

  it("the policy of a parent with no agent changed: refused, nothing sent", async () => {
    const resumed = resumedAcross({ root: [RootAllow] }, { root: [RootMask] });

    await expect(resumed).rejects.toBeInstanceOf(IncompatibleResumeError);
    expect(sent).toEqual([]);
  });

  it("the parent's policy dropped: refused", async () => {
    await expect(resumedAcross({ root: [RootAllow] }, {})).rejects.toBeInstanceOf(
      IncompatibleResumeError,
    );
  });

  it("the child's inherited policy unchanged and its own changed: refused", async () => {
    const resumed = resumedAcross(
      { root: [RootAllow], own: [OwnAllow] },
      { root: [RootAllow], own: [OwnMask] },
    );

    await expect(resumed).rejects.toBeInstanceOf(IncompatibleResumeError);
    expect(sent).toEqual([]);
  });

  it("nothing changed: resumes and finishes", async () => {
    const policies = { application: [AppAllow], root: [RootAllow], own: [OwnMask] };

    const done = await resumedAcross(policies, policies);

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(sent).toEqual(["boss@example.com"]);
  });
});

const depsOf = async (policies: Policies): Promise<AppDeps> =>
  createAppDeps((await applicationOf(deployment(policies).app)).workflows[0] ?? fail(), {
    gateway: createScriptedGateway(new ScriptBook()),
    processEnv: {},
  });

function fail(): never {
  throw new TypeError("no workflow");
}

describe("#1150: what the hashes cover", () => {
  it("each inherited policy gives the root its own hash; the child's own hash never moves", async () => {
    const variants: readonly Policies[] = [
      {},
      { root: [RootAllow] },
      { root: [RootMask] },
      { application: [AppAllow] },
      { application: [AppMask] },
    ];
    const built = await Promise.all(variants.map(depsOf));
    try {
      const roots = built.map((deps) => joinKeysOf(deps).configHash);
      const children = built.map(
        (deps) => joinKeysOf(ownDepsOf(deps, "cr-child-workflow")).configHash,
      );

      expect(new Set(roots).size).toBe(variants.length);
      // the root's and the root-only variants: the child declares the same in each
      expect(new Set(children.slice(0, 3)).size).toBe(1);
    } finally {
      await Promise.all(built.map((deps) => deps.close()));
    }
  });

  it("describe's hash is the running app's: the assembled lists hand down the same", async () => {
    const policies = { application: [AppAllow], root: [RootMask] };
    const [root] = (await applicationOf(deployment(policies).app)).workflows;
    const deps = await depsOf(policies);
    try {
      expect(await describedHash(deployment(policies).app)).toBe(joinKeysOf(deps).configHash);
      expect(configSnapshot(root ?? fail())).toMatchObject({
        handedDown: [
          { name: "cr-app-pii-policy", files: PiiFileAction.AllowOriginal },
          { name: "cr-root-pii-policy", files: PiiFileAction.Mask },
        ],
      });
    } finally {
      await deps.close();
    }
  });

  it("a middle workflow with no agent: its policy change moves the root's hash", async () => {
    const hashes = await Promise.all(
      [[], [RootAllow], [RootMask]].map((middle) => describedHash(nested(middle))),
    );

    expect(new Set(hashes).size).toBe(3);
  });

  it("a root that hands nothing down has no handed-down part: its hash is the one it was", async () => {
    const [root] = (await applicationOf(deployment({ own: [OwnMask] }).app)).workflows;

    expect(configSnapshot(root ?? fail())).not.toHaveProperty("handedDown");
  });

  it("a workflow that launches no other keeps its hash, whatever it lists", async () => {
    const { workflows } = await applicationOf(
      deployment({ application: [AppAllow], own: [OwnMask] }).app,
    );
    const child = workflows.find((workflow) => workflow.config.name === "cr-child-workflow");

    expect(configSnapshot(child ?? fail())).not.toHaveProperty("handedDown");
  });
});
