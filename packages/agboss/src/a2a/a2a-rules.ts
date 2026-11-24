import type { ApplicationOptions } from "../application/application.js";
import type { Class, Provider } from "../components/injection.js";
import { ComponentError, componentOf } from "../components/metadata.js";
import { moduleOf } from "../components/module.js";
import { flowClassesOf, withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { hasKindSuffix, kebabNameProblem, NameKind } from "../flow/names.js";
import { isFiniteNumber, shownLimit } from "../graph/count-limit.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type { A2AAgentMeta } from "./a2a-decorator.js";
import { startsOfEndpoint, type A2AEndpointMeta } from "./a2a-endpoint.decorator.js";
import { ttlViolations } from "./a2a-endpoint-ttl.js";

/**
 * The declared contracts of an application at assembly (#398 PR 3). Its `exposes` are `@A2AExpose`
 * or `@McpEndpoint` classes (`[application.not-an-endpoint]`), each name once
 * (`[application.duplicate-endpoint]`); an `@A2AExpose` exports `@WorkflowStart`s of the application's
 * workflows (`[application.endpoint-unknown-start]`). Names: kebab-case (`[name.not-kebab-case]`).
 */

/** `[name.not-kebab-case]` for a contract's `name`. */
function contractNameViolations(name: string, decorator: string, where: string): RuleViolation[] {
  const problem = kebabNameProblem(name, decorator);
  return problem === undefined ? [] : [violation(problem.code, problem.message, [where])];
}

/** The starts of the application's workflows and their children, by class. */
function startsOf(workflows: readonly Class[]): ReadonlySet<Class> {
  const starts = withChildWorkflows(workflows).flatMap((workflow) => {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) return [];
    return flowClassesOf(declaration.options.flow).filter(
      (node) => declarationOf(node)?.kind === NodeKind.Start,
    );
  });
  return new Set(starts);
}

/** What one `@A2AEndpoint` gets wrong: its description, ttl and skills. */
function a2aEndpointProblems(
  meta: A2AEndpointMeta,
  starts: ReadonlySet<Class>,
  where: string,
): RuleViolation[] {
  const found = contractNameViolations(meta.name, "@A2AEndpoint", where);
  if (meta.description.trim() === "") {
    const message = `${meta.name} has no description — the Agent Card's description says what the agent does for a caller that finds it`;
    found.push(violation("a2a.endpoint-description-required", message, [where]));
  }
  found.push(...ttlViolations(meta, where));
  const listed = startsOfEndpoint(meta);
  for (const [index, served] of listed.entries()) {
    if (!starts.has(served)) {
      const message = `${meta.name} serves ${served.name}, which is no @WorkflowStart of ${where}'s workflows — list a start of a listed workflow`;
      found.push(violation("application.endpoint-unknown-start", message, [where]));
    } else if (listed.indexOf(served) !== index) {
      const message = `${meta.name} lists the skill ${served.name} twice — one entry per start`;
      found.push(violation("a2a.duplicate-skill", message, [where]));
    }
  }
  return found;
}

function endpointViolations(options: ApplicationOptions): RuleViolation[] {
  const where = options.name;
  const starts = startsOf(options.workflows);
  const seen = new Set<string>();
  return (options.endpoints ?? []).flatMap((endpoint): RuleViolation[] => {
    const meta = componentOf(endpoint);
    if (meta?.kind !== "a2a-endpoint" && meta?.kind !== "mcp-endpoint") {
      const message = `${endpoint.name} in ${where}'s endpoints is neither an @A2AEndpoint nor an @McpEndpoint`;
      return [violation("application.not-an-endpoint", message, [where])];
    }
    const found: RuleViolation[] = [];
    if (seen.has(meta.meta.name)) {
      const message = `${where} serves two contracts named ${meta.meta.name} — one name per contract`;
      found.push(violation("application.duplicate-endpoint", message, [where]));
    }
    seen.add(meta.meta.name);
    return meta.kind === "mcp-endpoint"
      ? found
      : [...found, ...a2aEndpointProblems(meta.meta, starts, where)];
  });
}

/** The class a provider creates: the class listed, the class given for a token; none for a value. */
function createdClassOf(provider: Provider): Class | undefined {
  if (!("provide" in provider)) return provider;
  return "useClass" in provider ? provider.useClass : undefined;
}

/**
 * The classes the application and its workflows (and the child workflows they launch) provide — listed, or given
 * for a token with `provide(TOKEN, Class)`. `[a2a.price-invalid]` and the contract names are checked on these.
 */
function providersOf(options: ApplicationOptions): ReadonlySet<Class> {
  const ofWorkflows = withChildWorkflows(options.workflows)
    .filter((workflow) => declarationOf(workflow)?.kind === NodeKind.Workflow)
    .flatMap((workflow) => moduleOf(workflow).providers ?? []);
  const created = [...(options.providers ?? []), ...ofWorkflows].map(createdClassOf);
  // Stryker disable next-line ArrayDeclaration: a value provider would add a string, which no component is declared on, so the check passes it by
  return new Set(created.flatMap((cls) => cls ?? []));
}

/**
 * `[a2a.unknown-finish]` at assembly (#916): `@A2AAgent({ target: { finishes } })` names finishes of
 * the skill its typed `output` takes. What assembly can know without the remote card is refused here
 * — a list on an untyped agent (no output takes a finish), an empty list, a name that is no
 * `@WorkflowFinish` name (`…-workflow-finish`), a name twice; a well-formed name the skill does not
 * have is refused by the card check before anything is sent (`A2AContractRule.UnknownFinish`) and
 * by `agboss check --federation` against the receiver's snapshot.
 */

const CODE = "a2a.unknown-finish";

/** Why `finishes` names no finish a typed client could take; none when it can. */
function problemsOf(meta: A2AAgentMeta, finishes: readonly string[]): string[] {
  if (meta.output === undefined)
    return ["lists finishes but has no output DTO — only a typed agent takes some of them"];
  if (finishes.length === 0)
    return ["lists no finish — leave target.finishes out to take every finish of the skill"];
  const named = finishes.filter((finish) => !hasKindSuffix(finish, NameKind.WorkflowFinish));
  const repeated = finishes.filter((finish, index) => finishes.indexOf(finish) !== index);
  return [
    ...named.map((finish) => `"${finish}" is no @WorkflowFinish name (…-workflow-finish)`),
    ...[...new Set(repeated)].map((finish) => `"${finish}" is listed twice`),
  ];
}

/** The `target.finishes` violations of one `@A2AAgent`. */
function targetFinishesViolations(meta: A2AAgentMeta, where: string): RuleViolation[] {
  const finishes = meta.target?.finishes;
  if (finishes === undefined) return [];
  return problemsOf(meta, finishes).map((problem) =>
    violation(CODE, `${meta.name}'s target.finishes ${problem}`, [where]),
  );
}

/**
 * An A2A contract's price (#1382) is a finite number of dollars from 0 (`usd(...)`), or none. Anything else
 * — `NaN`, `Infinity`, a negative number, a word, `null`, an object — reaches a contract from untyped code,
 * a config file or parsed JSON; a negative one is not charged at the accept and is added to the settle's
 * charge, a `NaN` one throws after the peer accepted the task. `[a2a.price-invalid]` refuses it at assembly
 * (`@A2AAgent`) and, before anything is sent, at the call (a client built with a `contract`). The message names
 * the value by its kind, never by its text. Why `price` is no price a contract can hold: none when it is one
 * (or none is set).
 */
export const priceProblemOf = (price: unknown): string | undefined =>
  price === undefined || (isFiniteNumber(price) && price >= 0)
    ? undefined
    : `price is ${shownLimit(price)}, not a finite number of dollars from 0 — usd(...) sets it; leave it out for no price`;

/** Refuses a contract's `price` that is no finite number from 0, before the call sends or charges anything. */
export function checkedPrice(agent: string, price: unknown): void {
  const problem = priceProblemOf(price);
  if (problem !== undefined)
    throw new ComponentError({ message: `[a2a.price-invalid] ${agent}: ${problem}` });
}

/** `[a2a.price-invalid]` at assembly (#1382): the agent's `price` is a finite number of dollars from 0, or none. */
function priceViolations(meta: A2AAgentMeta, where: string): RuleViolation[] {
  const problem = priceProblemOf(meta.price);
  return problem === undefined
    ? []
    : [violation("a2a.price-invalid", `${meta.name}'s ${problem}`, [where])];
}

function a2aAgentViolations(options: ApplicationOptions): RuleViolation[] {
  const where = options.name;
  return [...providersOf(options)].flatMap((cls): RuleViolation[] => {
    const meta = componentOf(cls);
    if (meta?.kind !== "a2a-agent") return [];
    const { name } = meta.meta;
    // #809: the target is optional — a foreign agent has no application, one skill needs no name
    return [
      ...contractNameViolations(name, "@A2AAgent", where),
      ...targetFinishesViolations(meta.meta, where),
      ...priceViolations(meta.meta, where),
    ];
  });
}

/** The declared contracts' violations of an application. */
export const contractRuleViolations = (options: ApplicationOptions): RuleViolation[] => [
  ...endpointViolations(options),
  ...a2aAgentViolations(options),
];
