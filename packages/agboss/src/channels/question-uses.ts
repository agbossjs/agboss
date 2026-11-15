import type { Class } from "../components/injection.js";
import { expiresInOfQuestion, questionExpiriesOf } from "../flow/analyse/question-expiry.js";
import { flowClassesOf } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { channelRoleOptionsOf, isQuestionRole } from "./channel-role.decorator.js";
import type { ChannelUse } from "./discovery.js";

/** The question roles of a workflow's flow, as channel uses (#659, #712): its question steps and its agents' question tools. */

/** The question steps of a workflow's flow (#659), each role once: its node's declaration. */
export function questionUsesOf(workflow: Class, name: string): readonly ChannelUse[] {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) return [];
  const expiries = questionExpiriesOf(declaration.options.flow);
  return [...new Set(flowClassesOf(declaration.options.flow))].flatMap((node) => {
    const question = declarationOf(node);
    if (question?.kind !== NodeKind.Question) return [];
    const { options } = question;
    const { ask } = options.input;
    const expiresIn = expiresInOfQuestion(expiries, node);
    return [
      {
        tool: options.name,
        toolInput: ask,
        channel: node,
        workflow: name,
        isQuestion: true,
        ...(expiresIn === undefined ? {} : { expiresIn }),
      },
    ];
  });
}

/** The question roles the agents of a workflow's flow ask through their tools (#712), per agent. */
export function agentQuestionUsesOf(workflow: Class, name: string): readonly ChannelUse[] {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) return [];
  return [...new Set(flowClassesOf(declaration.options.flow))].flatMap((node) => {
    const agent = declarationOf(node);
    if (agent?.kind !== NodeKind.Agent) return [];
    return [...new Set(agent.options.tools ?? [])].flatMap((cls): readonly ChannelUse[] => {
      const options = channelRoleOptionsOf(cls);
      if (options === undefined || !isQuestionRole(options)) return [];
      const { name: tool, ask } = options;
      const askedBy = agent.options.name;
      return [{ tool, toolInput: ask, channel: cls, workflow: name, isQuestion: true, askedBy }];
    });
  });
}
