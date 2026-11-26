import { ComponentKind } from "../flow/runtime/records.js";
import type { Class } from "../components/injection.js";
import { flowClassesOf } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { externalTaskOf } from "./discovery.js";
import type { ChannelUse } from "./discovery.js";

/** The external tasks of a workflow's flow, as channel uses (#659, #712): its steps and its agents' tools. */

/** The external-task steps of a workflow's flow (#659), each target once: its node's declaration. */
export function questionUsesOf(workflow: Class, name: string): readonly ChannelUse[] {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== ComponentKind.Workflow) return [];
  return [...new Set(flowClassesOf(declaration.options.flow))].flatMap((node) => {
    const question = declarationOf(node);
    if (question?.kind !== ComponentKind.ExternalTask) return [];
    const { options } = question;
    return [
      {
        tool: options.name,
        toolInput: options.input.ask,
        target: node,
        workflow: name,
        isQuestion: true,
      },
    ];
  });
}

/** The external tasks the agents of a workflow's flow ask through their tools (#712), per agent. */
export function agentQuestionUsesOf(workflow: Class, name: string): readonly ChannelUse[] {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== ComponentKind.Workflow) return [];
  return [...new Set(flowClassesOf(declaration.options.flow))].flatMap((node) => {
    const agent = declarationOf(node);
    if (agent?.kind !== ComponentKind.Agent) return [];
    return [...new Set(agent.options.tools ?? [])].flatMap((cls): readonly ChannelUse[] => {
      const options = externalTaskOf(cls);
      if (options === undefined) return [];
      const { name: tool, input } = options;
      const askedBy = agent.options.name;
      return [{ tool, toolInput: input, target: cls, workflow: name, isQuestion: true, askedBy }];
    });
  });
}
