/**
 * #1150 — every way to a child's deps reads its chain: the compile of a pass, a pause's notices and
 * reply interpreter (`ownDepsOf`), a reranker and a compaction (`policiesOf`, `workflowPolicies`),
 * the child's log. Exclusions remove a policy at the models only; `configHash` covers what the
 * workflow declares, never what it inherits on one way or another.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { createAppDeps } from "../../src/app/app-deps.js";
import { ownDepsOf } from "../../src/app/own-deps.js";
import { inChainOf } from "../../src/app/pii-chain.js";
import { replyAnsweringPartsOf } from "../../src/app/reply-answer.js";
import { workflowInApplication } from "../../src/application/workflow-application.js";
import { joinKeysOf } from "../../src/flow/runtime/workflow-keys.js";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import type { PiiPolicySet } from "../../src/pii/policy-set.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { TreeState } from "../../src/app/tree-move-types.js";
import {
  CHILD_SECRET,
  ChainPlainRootWorkflow,
  ChainRootWorkflow,
  EMAIL,
  ROOT_SECRET,
  TEXT,
} from "./chain.fixture.js";
import { PII_KEY_VARIABLE } from "./pii.fixture.js";

const namesOf = (set: PiiPolicySet | undefined): string[] =>
  (set?.policies ?? []).map((policy) => policy.name).sort();

const ROOT_CHAIN = ["child-secret-pii-policy", "contact-pii-policy", "root-secret-pii-policy"];
const WITHOUT_ROOT = ["child-secret-pii-policy", "contact-pii-policy"];

let root: AppDeps;
let plain: AppDeps;

const depsOf = async (workflow: new () => object): Promise<AppDeps> =>
  createAppDeps(await workflowInApplication(workflow), {
    gateway: createScriptedGateway(new ScriptBook()),
    processEnv: { [PII_KEY_VARIABLE]: "test-key" },
  });

beforeAll(async () => {
  root = await depsOf(ChainRootWorkflow);
  plain = await depsOf(ChainPlainRootWorkflow);
});

afterAll(async () => {
  await root.close();
  await plain.close();
});

describe("#1150 AC5: a child's deps under its chain", () => {
  it("AC5: observability, a model of no element (reply interpreter, compaction) and an agent (its reranker): the chain", () => {
    const child = ownDepsOf(root, "chain-child-workflow").pii;

    expect(namesOf(child?.observed)).toEqual(ROOT_CHAIN);
    expect(namesOf(child?.workflowPolicies)).toEqual(ROOT_CHAIN);
    expect(namesOf(child?.policiesOf("chain-child-agent"))).toEqual(ROOT_CHAIN);
    expect(namesOf(child?.policiesOf("chain-child-router"))).toEqual(ROOT_CHAIN);
    // a launch's copy reads as its agent
    expect(namesOf(child?.policiesOf("chain-child-agent#2"))).toEqual(ROOT_CHAIN);
  });

  it("AC5: @Workflow({ excludePiiPolicies }) removes the root's policy at every model, never at observability", () => {
    const open = ownDepsOf(root, "chain-open-workflow").pii;

    expect(namesOf(open?.observed)).toEqual(ROOT_CHAIN);
    expect(namesOf(open?.workflowPolicies)).toEqual(WITHOUT_ROOT);
    expect(namesOf(open?.policiesOf("chain-open-agent"))).toEqual(WITHOUT_ROOT);
  });

  it("AC5: an agent's excludePiiPolicies removes it at that agent only", () => {
    const peek = ownDepsOf(root, "chain-peek-workflow").pii;

    expect(namesOf(peek?.policiesOf("chain-peek-agent"))).toEqual(WITHOUT_ROOT);
    expect(namesOf(peek?.workflowPolicies)).toEqual(ROOT_CHAIN);
    expect(namesOf(peek?.observed)).toEqual(ROOT_CHAIN);
  });

  it("AC5: the same workflow under a root that does not list it: its own and the application's only", () => {
    const peek = ownDepsOf(plain, "chain-peek-workflow").pii;

    expect(namesOf(peek?.observed)).toEqual(WITHOUT_ROOT);
  });

  it("AC5: a pause notice of the child is masked by its chain (bug 4)", async () => {
    const mask = ownDepsOf(root, "chain-child-workflow").pii?.observability;

    const shown = JSON.stringify(await mask?.value({ ask: TEXT }));

    expect(shown).not.toContain(ROOT_SECRET);
    expect(shown).not.toContain(CHILD_SECRET);
    expect(shown).not.toContain(EMAIL);
  });

  it("AC5: a reply interpreter of the child's pause reads through the child's chain, less its workflow's excludes", () => {
    const parts = replyAnsweringPartsOf(root);
    const state = { piiTokens: {}, piiKey: null } as Partial<TreeState> as TreeState;
    const pauseIn = (workflow: string): PauseRecord =>
      ({ workflow }) as Partial<PauseRecord> as PauseRecord;

    expect(namesOf(parts.piiOf(state, pauseIn("chain-child-workflow")).policies)).toEqual(
      ROOT_CHAIN,
    );
    expect(namesOf(parts.piiOf(state, pauseIn("chain-open-workflow")).policies)).toEqual(
      WITHOUT_ROOT,
    );
    expect(namesOf(parts.piiOf(state, pauseIn("chain-root-workflow")).policies)).toEqual([
      "contact-pii-policy",
      "root-secret-pii-policy",
    ]);
  });

  it("AC5: the child's log is masked by its chain", () => {
    const lines: string[] = [];
    const log: FrameworkLog = {
      info: (_code, message) => lines.push(message),
      warn: (_code, message) => lines.push(message),
      error: (_code, message) => lines.push(message),
    };
    const peek = ownDepsOf(plain, "chain-peek-workflow");
    const inherited = root.pii?.observed.policies ?? [];

    const chained = inChainOf({ ...peek, log }, inherited, () => undefined);
    chained.log?.warn("x", TEXT);

    expect(lines.join("\n")).not.toContain(ROOT_SECRET);
    expect(lines.join("\n")).not.toContain(CHILD_SECRET);
  });

  it("AC5: configHash covers what a workflow declares — one hash under any chain", () => {
    const underRoot = ownDepsOf(root, "chain-peek-workflow");
    const underPlain = ownDepsOf(plain, "chain-peek-workflow");

    expect(underRoot.pii).not.toBe(underPlain.pii);
    expect(joinKeysOf(underRoot).configHash).toBe(joinKeysOf(underPlain).configHash);
  });
});
