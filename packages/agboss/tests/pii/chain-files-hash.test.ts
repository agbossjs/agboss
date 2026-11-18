/**
 * #1150 × #899 (#1224): a child's configHash covers the PII policies it declares, file actions
 * included, never what it inherits on a way in — a parent's file-action policy masks the child
 * (its chain) without changing the child's hash; the child's own declared file action does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Agent,
  PiiAction,
  PiiFileAction,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { workflowInApplication } from "../../src/application/workflow-application.js";
import { createAppDeps, type AppDeps } from "../../src/app/app-deps.js";
import { ownDepsOf } from "../../src/app/own-deps.js";
import { joinKeysOf } from "../../src/flow/runtime/workflow-keys.js";
import { elementFingerprintsOf } from "../../src/run/fingerprints.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";

const none = (): readonly PiiMatch[] => [];

/** A parent's policy that lets the original files through to the models (#899). */
@PiiPolicy({
  name: "fh-parent-files-pii-policy",
  action: PiiAction.replaceWithKind(),
  files: PiiFileAction.AllowOriginal,
})
class ParentFilesPiiPolicy implements PiiPolicyHandler {
  findMatches = none;
}

/** The child's own policy, masking files. */
@PiiPolicy({
  name: "fh-own-pii-policy",
  action: PiiAction.replaceWithKind(),
  files: PiiFileAction.Mask,
})
class OwnMaskPiiPolicy implements PiiPolicyHandler {
  findMatches = none;
}

/** The same policy (by name) with another file action: what changing the declaration is. */
@PiiPolicy({
  name: "fh-own-pii-policy",
  action: PiiAction.replaceWithKind(),
  files: PiiFileAction.AllowOriginal,
})
class OwnAllowPiiPolicy implements PiiPolicyHandler {
  findMatches = none;
}

@Agent({ name: "fh-child-agent", description: "d", prompt: "p", model: "test/fh" })
class FhChildAgent {}

@WorkflowStart({ name: "fh-child-workflow-start", description: "s", input: WorkflowStartTextDto })
class FhChildStart {}

@WorkflowFinish({
  name: "fh-child-workflow-finish",
  description: "f",
  output: WorkflowFinishTextDto,
})
class FhChildFinish {}

@Workflow({
  name: "fh-child-workflow",
  version: "1.0.0",
  flow: [
    start(FhChildStart).returns(WorkflowStartTextDto).toAgent(FhChildAgent).toFinish(FhChildFinish),
  ],
  piiPolicies: [OwnMaskPiiPolicy],
})
class FhChildWorkflow {}

@WorkflowFinish({
  name: "fh-root-workflow-finish",
  description: "f",
  output: WorkflowFinishTextDto,
})
class FhRootFinish {}

const rootOf = (name: string, piiPolicies: readonly (new () => object)[]) => {
  @WorkflowStart({ name: `${name}-start`, description: "s", input: WorkflowStartTextDto })
  class RootStart {}
  @Workflow({
    name,
    version: "1.0.0",
    flow: [
      start(RootStart)
        .returns(WorkflowStartTextDto)
        .toWorkflow(FhChildWorkflow)
        .returns(WorkflowFinishTextDto)
        .toFinish(FhRootFinish),
    ],
    piiPolicies,
  })
  class Root {}
  return Root;
};

const FilesRoot = rootOf("fh-files-root-workflow", [ParentFilesPiiPolicy]);
const PlainRoot = rootOf("fh-plain-root-workflow", []);

@Application({
  name: "fh-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FilesRoot, PlainRoot],
  budgets: TEST_BUDGETS,
})
export class FhApplication {}

let files: AppDeps;
let plain: AppDeps;

const depsOf = async (workflow: new () => object): Promise<AppDeps> =>
  createAppDeps(await workflowInApplication(workflow), {
    gateway: createScriptedGateway(new ScriptBook()),
    processEnv: {},
  });

beforeAll(async () => {
  files = await depsOf(FilesRoot);
  plain = await depsOf(PlainRoot);
});

afterAll(async () => {
  await files.close();
  await plain.close();
});

describe("#1150 × #1224: the configHash of a child under a parent's file-action policy", () => {
  it("the inherited file-action policy masks the child, never changes its hash", () => {
    const underFiles = ownDepsOf(files, "fh-child-workflow");
    const underPlain = ownDepsOf(plain, "fh-child-workflow");
    const names = (deps: AppDeps | typeof underFiles): string[] =>
      (deps.pii?.policiesOf("fh-child-agent").policies ?? []).map((policy) => policy.name);

    expect(names(underFiles)).toEqual(["fh-own-pii-policy", "fh-parent-files-pii-policy"]);
    expect(names(underPlain)).toEqual(["fh-own-pii-policy"]);
    expect(elementFingerprintsOf(underFiles)).toEqual(elementFingerprintsOf(underPlain));
    expect(joinKeysOf(underFiles).configHash).toBe(joinKeysOf(underPlain).configHash);
  });

  it("changing the child's own declared file action changes what its hash covers", async () => {
    const bundle = await workflowInApplication(FhChildWorkflow);
    const pii = bundle.pii;
    if (pii === undefined) throw new Error("the child's PII policies are assembled");
    const declaring = (policy: new () => object) => ({
      ...bundle,
      pii: { ...pii, byElement: new Map([["fh-child-agent", [policy]]]) },
    });

    const masked = elementFingerprintsOf(declaring(OwnMaskPiiPolicy));
    const allowed = elementFingerprintsOf(declaring(OwnAllowPiiPolicy));

    expect(masked["fh-child-agent"]?.piiPolicies).toEqual([
      expect.objectContaining({ name: "fh-own-pii-policy", files: PiiFileAction.Mask }),
    ]);
    expect(allowed["fh-child-agent"]?.piiPolicies).toEqual([
      expect.objectContaining({ name: "fh-own-pii-policy", files: PiiFileAction.AllowOriginal }),
    ]);
    expect(masked).not.toEqual(allowed);
  });
});
