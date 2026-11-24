import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import type { LoadedModule } from "../../../src/flow/analyse/rules/context.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import {
  GENERATED_TYPES_FILE,
  generateFlowTypes,
  type FlowTypesRequest,
} from "../../../src/flow/types/generate.js";
import { loadFlowProject } from "../../../src/loader/load-flow.js";
import { MAX_EXACT_INPUT_SHAPES } from "../../../src/flow/types/inputs.js";
import { RouteForm, routerAnswerText, routeTargetsOf } from "../../../src/flow/types/tables.js";
import { DecidedBy, SpawnPolicy, type RouterOptions } from "../../../src/flow/decorators/router.js";
import { ChargeResultDto, SupportIntentDto } from "../fixtures/credit-dtos.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Text } from "../../../src/dto/index.js";
import {
  DeliveryTopicAgent,
  OrderTopicAgent,
  RefundTopicAgent,
  TopicsRouter,
} from "../fixtures/topics.fixture.js";

const routerOptionsOf = (router: Class): RouterOptions => {
  const declaration = declarationOf(router);
  if (declaration?.kind !== NodeKind.Router) throw new TypeError("not a router");
  return declaration.options;
};

const TopicsRouterOptions = routerOptionsOf(TopicsRouter);

const LaunchingModelRouterOptions: RouterOptions = {
  name: "launching-router",
  description: "A model router before a launch",
  decidedBy: DecidedBy.Model,
  input: { intent: SupportIntentDto },
  routes: [
    { target: OrderTopicAgent, prompt: "The order" }, // no spawn: Always (the model router's default)
    { target: RefundTopicAgent, spawn: SpawnPolicy.OnDemand, prompt: "Refunds" },
  ],
};
import { FIXTURE_WORKFLOWS } from "./fixture-workflows.js";
import { applicationDeclarationOf } from "../../../src/application/application.js";

/** Type generation for the v2 fixtures (#272 PR 3, #270 AC13, S2–S4, S39). */

const framework = new URL("../../../", import.meta.url).pathname;
const fixtures = new URL("../fixtures/", import.meta.url).pathname;
const outFile = join(framework, GENERATED_TYPES_FILE);
const tablesModule = join(framework, "src/flow/generated-types.ts");

/**
 * Every fixture module with its named exports — what the loader records under tsx — and the
 * framework's DTO module the fixtures import (a channel role's ask and answer DTOs, #267).
 */
async function fixtureModules(): Promise<readonly LoadedModule[]> {
  const files = [
    ...readdirSync(fixtures)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
      .map((file) => join(fixtures, file)),
    join(framework, "src/dto/index.ts"),
    // the flow's public entry
    join(framework, "src/public/flow.ts"),
  ];
  return Promise.all(
    files.map(async (file) => ({
      file,
      exports: (await import(file)) as Readonly<Record<string, unknown>>,
    })),
  );
}

const isFlowWorkflow = (value: unknown): value is Class =>
  typeof value === "function" && declarationOf(value)?.kind === NodeKind.Workflow;

async function workflowsOf(files: readonly string[]): Promise<readonly Class[]> {
  const modules = await Promise.all(
    files.map(async (file) => (await import(file)) as Record<string, unknown>),
  );
  return modules.flatMap((module) => Object.values(module).filter(isFlowWorkflow));
}

/** The fixtures' `@Application` classes (#261: their contexts type the starts' options). */
async function applicationsOf(files: readonly string[]): Promise<readonly Class[]> {
  const modules = await Promise.all(
    files.map(async (file) => (await import(file)) as Record<string, unknown>),
  );
  return modules.flatMap((module) =>
    Object.values(module).filter(
      (value): value is Class =>
        typeof value === "function" && applicationDeclarationOf(value as Class) !== undefined,
    ),
  );
}

async function requestFor(files: readonly string[]): Promise<FlowTypesRequest> {
  return {
    workflows: await workflowsOf(files),
    applications: await applicationsOf(files),
    components: (await loadFlowProject(files, { typescript: false })).components,
    modules: await fixtureModules(),
    outFile,
    tablesModule,
  };
}

class HiddenDto {
  @Text({ prompt: "a note" })
  note!: string;
}

const run = promisify(execFile);

const credit = join(fixtures, "credit.fixture.ts");

describe("#270 AC13: agboss check generates .agboss/types.d.ts for the fixtures", () => {
  it("the generated file matches its snapshot", async () => {
    const generated = generateFlowTypes(await requestFor(FIXTURE_WORKFLOWS));

    expect(generated.errors.map((found) => found.code)).toEqual([
      "graph.ambiguous-start",
      "launch.item-not-read",
      "flow.unused-output",
      "input.missing-on-path",
      "router.policy-with-choose-one",
    ]); // the broken workflows are broken on purpose; topics-workflow keeps policies on .chooseOne(…)
    await expect(generated.text).toMatchFileSnapshot("./__snapshots__/fixtures.types.d.ts.snap");
  }, 240_000); // loads every fixture module, as the check:types step below does (#1228: see below)

  it("regenerating gives the same file: sorted keys, whatever the order of workflows and modules", async () => {
    const request = await requestFor(FIXTURE_WORKFLOWS);
    const reversed: FlowTypesRequest = {
      ...request,
      workflows: [...request.workflows].reverse(),
      modules: [...request.modules].reverse(),
    };

    expect(generateFlowTypes(reversed).text).toBe(generateFlowTypes(request).text);
  });

  it("the check:types step writes the same bytes (no drift between the step and the generator)", async () => {
    await run(process.execPath, [join(framework, "../../scripts/check-types.mjs")]);

    const generated = generateFlowTypes(await requestFor(FIXTURE_WORKFLOWS));
    expect(readFileSync(outFile, "utf8")).toBe(generated.text);
    // a spawn of node over every fixture module: 4.9 s for the file alone, over 60 s in a full run with
    // three workers and the fault suite beside it (#1228, as #1160): the bound says "not hung"
  }, 240_000);
});

describe("S4: InputOf is an exact union up to 32 input shapes, flat above", () => {
  it("32 shapes: an exact union, no note; 64: one flat object and an info line", async () => {
    const generated = generateFlowTypes(await requestFor([join(fixtures, "wide.fixture.ts")]));
    const text = generated.text ?? "";
    const five = text.slice(
      text.indexOf('      "five-parts-agent":\n'),
      text.indexOf('"five-parts-workflow-start": {'),
    );

    expect(MAX_EXACT_INPUT_SHAPES).toBe(32);
    expect(five.split("\n        | ").length - 1).toBe(32);
    expect(text).toContain(
      '      "six-parts-agent": { first?: Produced<FirstPartDto, typeof SixPartsWorkflowStart>; second?: ',
    );
    expect(generated.notes).toEqual([
      "six-parts-agent: 64 input shapes — InputOf is flat (no narrowing between fields)",
    ]);
  });
});

describe("S2: [types.unexported-class]", () => {
  it("a component or a DTO the types need that no module exports fails generation", async () => {
    const generated = generateFlowTypes(
      await requestFor([join(fixtures, "unexported.fixture.ts")]),
    );

    expect(generated.text).toBeUndefined();
    expect(generated.errors.map(({ code, message }) => `[${code}] ${message}`)).toEqual([
      "[types.unexported-class] HiddenAgent (tests/flow/fixtures/unexported.fixture.ts) is not exported — export it",
      "[types.unexported-class] HiddenDto is not exported — export it",
    ]);
  });
});

describe("S39: DTO classes are branded too", () => {
  it("each DTO by its class name, in DtoBrands and by module augmentation", async () => {
    const { text } = generateFlowTypes(await requestFor([join(fixtures, "markers.fixture.ts")]));

    expect(text).toContain('      "ApprovedVerdictDto": ApprovedVerdictDto;\n');
    expect(text).toContain(
      'declare module "../tests/flow/fixtures/markers.fixture.js" {\n  interface ApprovedVerdictDto {\n    readonly [agbossDto]?: "ApprovedVerdictDto";\n  }',
    );
    expect(text).toContain(
      '  interface VerdictAgent {\n    readonly [agbossComponent]?: { readonly name: "verdict-agent"; readonly kind: NodeKind.Agent };\n  }',
    );
  });
});

describe("#280: Route<R> and what route() returns", () => {
  it("Routes after .chooseOne(…) lists every target; RouterAnswers is written for every router (#262)", async () => {
    const { text } = generateFlowTypes(
      await requestFor([join(fixtures, "credit.fixture.ts"), join(fixtures, "topics.fixture.ts")]),
    );

    expect(text).toContain(
      '    interface Routes {\n      "credit-limit-by-model-router": typeof ApprovalAgent | typeof ChargeCardAction;\n      "credit-limit-router": typeof ApprovalAgent | typeof ChargeCardAction;\n      "desk-router": typeof NoOrderWorkflowFinish | typeof OrderIntakeAgent;\n      "topics-router": typeof DeliveryTopicAgent | typeof OrderTopicAgent | typeof RefundTopicAgent;\n    }',
    );
    expect(text).toContain(
      '    interface RouterAnswers {\n      "credit-limit-by-model-router": typeof ApprovalAgent | typeof ChargeCardAction;\n      "credit-limit-router": typeof ApprovalAgent | typeof ChargeCardAction;\n      "desk-router": typeof NoOrderWorkflowFinish | typeof OrderIntakeAgent;\n      "topics-router": typeof DeliveryTopicAgent | typeof OrderTopicAgent | typeof RefundTopicAgent;\n    }',
    );
  });

  it("before a launch Route<R> leaves Always out, by each kind's default", () => {
    expect(routeTargetsOf(TopicsRouterOptions, RouteForm.List)).toEqual([
      RefundTopicAgent,
      DeliveryTopicAgent,
    ]);
    expect(routeTargetsOf(TopicsRouterOptions, RouteForm.One)).toHaveLength(3);
    // a model router's route without spawn is Always: only the explicit OnDemand one is chosen
    expect(routeTargetsOf(LaunchingModelRouterOptions, RouteForm.List)).toEqual([RefundTopicAgent]);
  });

  it("one target after .chooseOne(…); a list before a launch, which may be empty (#1279)", () => {
    const route = "typeof A | typeof B";

    expect(routerAnswerText(route, RouteForm.One)).toBe(route);
    expect(routerAnswerText(route, RouteForm.List)).toBe("readonly (typeof A | typeof B)[]");
    expect(routerAnswerText("typeof A", RouteForm.List)).toBe("readonly typeof A[]");
  });
});

describe("#1324g: every decorated class is typed, a workflow reaches it or not", () => {
  const classesOf = async (names: readonly string[]): Promise<readonly Class[]> => {
    const exports = (await import(credit)) as Record<string, Class>;
    return names.flatMap((name) => exports[name] ?? []);
  };

  it("an action, an agent and a router under test get their entries and brands with no workflow", async () => {
    const request = await requestFor([credit]);
    const components = await classesOf([
      "ChargeCardAction",
      "ApprovalAgent",
      "DeskRouter",
      "CreditWorkflowFinish",
    ]);
    const { text, errors } = generateFlowTypes({ ...request, workflows: [], components });

    expect(errors).toEqual([]);
    expect(text).toContain('"charge-card-action": { order: Produced<CreditOrderDto, never>;');
    expect(text).toContain("approval?: Produced<CreditApprovalDto, never> | undefined }");
    expect(text).toContain('"charge-card-action": ChargeResultDto;');
    expect(text).toContain('"credit-workflow-finish": ChargeResultDto;');
    expect(text).toContain(
      '"desk-router": typeof NoOrderWorkflowFinish | typeof OrderIntakeAgent | readonly (typeof NoOrderWorkflowFinish | typeof OrderIntakeAgent)[];',
    );
    expect(text).toContain('"approval-agent": never;');
    expect(text).toContain(
      'readonly [agbossComponent]?: { readonly name: "charge-card-action"; readonly kind: NodeKind.Action };',
    );
  });

  it("a class a workflow reaches keeps its path-sensitive entry", async () => {
    const request = await requestFor([credit]);
    const components = await classesOf(["ChargeCardAction", "ApprovalAgent", "DeskRouter"]);
    const withComponents = generateFlowTypes({ ...request, components }).text;

    expect(withComponents).toBe(generateFlowTypes(request).text);
    expect(withComponents).not.toContain("Produced<CreditOrderDto, never>");
  });

  it("a class under a name a workflow's component has is left out, never overwriting it", async () => {
    const request = await requestFor([credit]);
    @Action({
      name: "charge-card-action",
      description: "A look-alike under the same name",
      output: SupportIntentDto,
    })
    class LookAlikeAction {
      execute(): Promise<undefined> {
        return Promise.resolve(undefined);
      }
    }
    const generated = generateFlowTypes({
      ...request,
      workflows: [],
      components: [...(await classesOf(["ChargeCardAction"])), LookAlikeAction],
    });

    expect(generated.text).toContain('"charge-card-action": ChargeResultDto;');
    expect(generated.text).not.toContain('"charge-card-action": SupportIntentDto;');
    expect(generated.text).not.toContain("LookAlikeAction");
  });

  it("a class that needs a type no module exports is left out, not a failure", async () => {
    const request = await requestFor([credit]);
    @Action({
      name: "hidden-input-action",
      description: "Reads a DTO no module exports",
      input: { order: HiddenDto },
    })
    class HiddenInputAction {
      execute(): Promise<undefined> {
        return Promise.resolve(undefined);
      }
    }
    const generated = generateFlowTypes({
      ...request,
      workflows: [],
      components: [HiddenInputAction],
    });

    expect(generated.errors).toEqual([]);
    expect(generated.text).not.toContain("hidden-input-action");
  });
});
