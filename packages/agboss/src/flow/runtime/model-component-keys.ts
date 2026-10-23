import { nameOf } from "../../components/name-of.js";
import { judgeClassesOf } from "../../components/judge-parts.js";
import { isCodeJudge } from "../../components/judge-decorators.js";
import { normalisePromptText } from "../../components/prompt-render.js";
import type { AssembledCompactions } from "../../compaction/assembly.js";
import { CompactionStrategy } from "../../compaction/compaction.decorator.js";
import type { AssembledReplyInterpreter } from "../../channels/discovery.js";
import type { AssembledGuardrails } from "../../guardrails/assembly.js";
import type { AssembledPii } from "../../pii/assembly.js";
import { isCustomPolicy } from "../../pii/pii-policy.decorator.js";
import { piiPolicyMetaOf } from "../../pii/policy-checks.js";
import { versionOf } from "../../terns/index.js";
import type { ArbiterClass } from "../ast.js";
import { arbiterOf, isCodeArbiter } from "../decorators/arbiter.js";
import { DecidedBy } from "../decorators/router.js";
import { agentMetasOf } from "./agents.js";
import type { RuntimeGraph } from "./graph-model.js";
import { describedShapeOf, dtoSchemaHashOf } from "./join-keys.js";
import { arbiterClassesOf } from "./launch/runtime-launch.js";
import { ComponentKind, type ComponentRecord } from "./records.js";

/**
 * The join keys of the components that call a model but are no node of the flow (#395 PR 5b):
 * model judges, model guardrails, model arbiters, compactions that write summaries, model reply
 * interpreters and PII policies that detect with a model — each a `ComponentRecord` like a node's,
 * the same in `agboss describe --json` (`modelComponents`) and in a VCR cassette, so a recording of
 * one is found stale when what its model is told (`promptHash`) or what it reads (`schemaHash`)
 * changed. A judge's questions are its code's, so a judge has only its `schemaHash` (the `reply` it
 * judges); a component decided by code calls no model and has none.
 */

/** What the records are made from: the workflow's graph and its assembled model users. */
export interface ModelComponentSource {
  readonly graph: RuntimeGraph;
  readonly guardrails?: AssembledGuardrails | undefined;
  readonly compactions?: AssembledCompactions | undefined;
  readonly replyInterpreters?: readonly AssembledReplyInterpreter[] | undefined;
  readonly pii?: AssembledPii | undefined;
}

const recordOf = (
  name: string,
  kind: ComponentKind,
  promptHash: string | undefined,
  schemaHash: string | undefined,
): ComponentRecord => ({ name, kind, promptHash, schemaHash });

/** The model judges of the agents: the reply each judges. */
const judgeRecordsOf = (graph: RuntimeGraph): ComponentRecord[] =>
  [...judgeClassesOf(agentMetasOf(graph)).values()].flatMap(({ meta }) =>
    isCodeJudge(meta)
      ? []
      : [
          recordOf(
            meta.name,
            ComponentKind.Judge,
            undefined,
            versionOf(describedShapeOf(meta.reply)),
          ),
        ],
  );

/** The hash of a model arbiter's texts — its prompt and each agent's criterion — as describe gives it. */
export function arbiterPromptHashOf(arbiter: ArbiterClass): string | undefined {
  const options = arbiterOf(arbiter)?.options;
  if (options === undefined || isCodeArbiter(options)) return undefined;
  const criteria = options.criteria.map(({ agent, prompt }) => ({
    agent: nameOf(agent),
    prompt: normalisePromptText(prompt),
  }));
  return versionOf({ prompt: normalisePromptText(options.prompt), criteria });
}

const arbiterRecordsOf = (graph: RuntimeGraph): ComponentRecord[] =>
  arbiterClassesOf(graph.launches).flatMap((arbiter) => {
    const name = arbiterOf(arbiter)?.options.name;
    const promptHash = arbiterPromptHashOf(arbiter);
    return name === undefined || promptHash === undefined
      ? []
      : [recordOf(name, ComponentKind.Arbiter, promptHash, undefined)];
  });

const guardrailRecordsOf = (guardrails: AssembledGuardrails | undefined): ComponentRecord[] =>
  (guardrails?.guardrails ?? []).flatMap((guardrail) =>
    guardrail.decidedBy === DecidedBy.Code
      ? []
      : [
          recordOf(
            guardrail.name,
            ComponentKind.Guardrail,
            versionOf({ prompt: guardrail.prompt }),
            undefined,
          ),
        ],
  );

const compactionRecordsOf = (compactions: AssembledCompactions | undefined): ComponentRecord[] =>
  (compactions?.compactions ?? []).flatMap((compaction) =>
    compaction.strategy === CompactionStrategy.SummaryQueue ||
    compaction.strategy === CompactionStrategy.SingleSummary
      ? [
          recordOf(
            compaction.name,
            ComponentKind.Compaction,
            versionOf({ prompt: compaction.prompt, strategy: compaction.strategy }),
            undefined,
          ),
        ]
      : [],
  );

const interpreterRecordsOf = (
  interpreters: readonly AssembledReplyInterpreter[] | undefined,
): ComponentRecord[] =>
  (interpreters ?? []).flatMap((interpreter) =>
    interpreter.model === undefined
      ? []
      : [
          recordOf(
            interpreter.name,
            ComponentKind.ReplyInterpreter,
            versionOf({ instructions: interpreter.instructions }),
            dtoSchemaHashOf(interpreter.answer),
          ),
        ],
  );

/** A PII policy that detects with a model: the kinds its rules ask the model to find. */
const piiRecordsOf = (pii: AssembledPii | undefined): ComponentRecord[] =>
  (pii?.classes ?? []).flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined || isCustomPolicy(meta) || meta.detectWithModel === undefined) return [];
    const targets = meta.rules.map((rule) => rule.target);
    return [recordOf(meta.name, ComponentKind.PiiPolicy, versionOf({ targets }), undefined)];
  });

/** Every model component of the workflow but its nodes, each once, by name. */
export function modelComponentRecordsOf(source: ModelComponentSource): readonly ComponentRecord[] {
  const records = [
    ...judgeRecordsOf(source.graph),
    ...guardrailRecordsOf(source.guardrails),
    ...arbiterRecordsOf(source.graph),
    ...compactionRecordsOf(source.compactions),
    ...interpreterRecordsOf(source.replyInterpreters),
    ...piiRecordsOf(source.pii),
  ];
  const byName = new Map(records.map((record) => [record.name, record]));
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
