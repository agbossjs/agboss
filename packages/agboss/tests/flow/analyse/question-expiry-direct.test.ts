/**
 * #1366: the deadlines of a flow's question steps (#941), read from hand-built paths: every mention of a question, in
 * every sub-path, the one `expiresIn` a question has, and the exact violations for a value that is no duration or two
 * mentions that differ. The shard `assembly-rules` mutates `question-expiry.ts` whole.
 */
import { describe, expect, it } from "vitest";
import {
  expiresInOfQuestion,
  questionExpiriesOf,
  questionExpiryRules,
} from "../../../src/flow/analyse/question-expiry.js";
import { NodeKind, StepKind } from "../../../src/flow/ast.js";
import { hours, seconds, workingHours, workingMinutes } from "../../../src/units/index.js";
import { graphOf, node } from "./graph-fixture.js";

class AskQuestion {
  readonly fixture = true;
}
class OtherQuestion {
  readonly fixture = true;
}
class SomeAction {
  readonly fixture = true;
}

const to = (target: object, targetKind: NodeKind, expiresIn?: unknown) => ({
  kind: StepKind.To,
  target,
  targetKind,
  ...(expiresIn === undefined ? {} : { expiresIn }),
});
const ask = (expiresIn?: unknown) => to(AskQuestion, NodeKind.Question, expiresIn);
const pathOf = (...steps: object[]) => ({ source: {}, steps });
const flowOf = (...paths: ReturnType<typeof pathOf>[]) => paths as never;

const contextOf = (flow: unknown, ...questions: readonly { name: string; component: object }[]) =>
  ({
    workflow: { name: "asking-workflow", flow },
    graph: graphOf(
      questions.map((one) => ({
        ...node(one.name, NodeKind.Question),
        component: one.component,
      })) as never,
      [],
      [],
    ),
  }) as never;

const rules = (flow: unknown, ...questions: readonly { name: string; component: object }[]) =>
  questionExpiryRules(contextOf(flow, ...questions)).map(({ code, message, nodes }) => ({
    code,
    message,
    nodes,
  }));

const ASKER = { name: "ask-question", component: AskQuestion };

describe("#1366: the mentions of a question", () => {
  it("collects every mention in path order, a mention without a deadline as undefined", () => {
    const flow = flowOf(
      pathOf(ask(hours(1)), to(SomeAction, NodeKind.Action, hours(9)), ask()),
      pathOf(to(OtherQuestion, NodeKind.Question, hours(2))),
    );

    expect([...questionExpiriesOf(flow)]).toEqual([
      [AskQuestion, [hours(1), undefined]],
      [OtherQuestion, [hours(2)]],
    ]);
  });

  it("reads the sub-paths of a router, an onError, a join and a quorum group", () => {
    const sub = (...steps: object[]) => ({ steps });
    const flow = flowOf(
      pathOf(
        { kind: StepKind.ChooseOne, routes: [{ path: sub(ask(hours(1))) }] },
        { kind: StepKind.OneOf, branches: [sub(ask(hours(2)))] },
        { kind: StepKind.OnError, path: sub(ask(hours(3))) },
        {
          kind: StepKind.Join,
          onError: [{ path: sub(ask(hours(4))) }],
        },
      ),
    );

    expect(questionExpiriesOf(flow).get(AskQuestion)).toEqual([
      hours(1),
      hours(2),
      hours(3),
      hours(4),
    ]);
  });

  it("takes the first deadline a mention names, and none for a question never named or never given one", () => {
    const expiries = questionExpiriesOf(flowOf(pathOf(ask(), ask(hours(2)), ask(hours(3)))));

    expect(expiresInOfQuestion(expiries, AskQuestion)).toBe(hours(2));
    expect(expiresInOfQuestion(expiries, OtherQuestion)).toBeUndefined();
    expect(
      expiresInOfQuestion(questionExpiriesOf(flowOf(pathOf(ask()))), AskQuestion),
    ).toBeUndefined();
  });
});

describe("#1366: the rules on a question's deadline", () => {
  it("finds nothing in one deadline, none, or the same twice, plain or working", () => {
    expect(rules(flowOf(pathOf(ask(hours(1)))), ASKER)).toEqual([]);
    expect(rules(flowOf(pathOf(ask())), ASKER)).toEqual([]);
    expect(rules(flowOf(pathOf(ask(hours(1)), ask(hours(1)))), ASKER)).toEqual([]);
    expect(rules(flowOf(pathOf(ask(workingHours(1)), ask(workingHours(1)))), ASKER)).toEqual([]);
    expect(rules(flowOf(pathOf(ask(seconds(1)))), ASKER)).toEqual([]);
  });

  it("names a deadline that is no duration of at least a second, once per mention", () => {
    const message = (shown: string) =>
      `ask-question: expiresIn is ${shown} — a deadline is a positive finite duration of at least seconds(1) and at most 5 years, like hours(4)`;

    expect(rules(flowOf(pathOf(ask(500), ask(500))), ASKER)).toEqual([
      { code: "channel.expires-in-invalid", message: message("500"), nodes: ["ask-question"] },
      { code: "channel.expires-in-invalid", message: message("500"), nodes: ["ask-question"] },
    ]);
    expect(
      rules(flowOf(pathOf(ask(workingMinutes(0.01)))), ASKER).map((one) => one.message),
    ).toEqual([message("600 ms of working time")]);
  });

  it("names mentions that differ, plain against working, or one against none", () => {
    const conflict = {
      code: "question.expires-in-conflict",
      message:
        "ask-question is asked with different expiresIn — one question is one node, so give every mention the same { expiresIn } (or none, and set it on the role)",
      nodes: ["ask-question"],
    };

    expect(rules(flowOf(pathOf(ask(hours(1)), ask(hours(2)))), ASKER)).toEqual([conflict]);
    expect(rules(flowOf(pathOf(ask(hours(1)), ask(workingHours(1)))), ASKER)).toEqual([conflict]);
    expect(rules(flowOf(pathOf(ask(hours(1)), ask())), ASKER)).toEqual([conflict]);
    expect(rules(flowOf(pathOf(ask(), ask(hours(1)))), ASKER)).toEqual([conflict]);
  });

  it("gives the invalid ones before the conflict, and reads a question that is no node as none", () => {
    const codes = rules(flowOf(pathOf(ask(100), ask(hours(1)))), ASKER).map((one) => one.code);

    expect(codes).toEqual(["channel.expires-in-invalid", "question.expires-in-conflict"]);
    expect(rules(flowOf(pathOf(ask(100))))).toEqual([]);
  });
});
