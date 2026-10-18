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
import { MAX_EXACT_INPUT_SHAPES } from "../../../src/flow/types/inputs.js";
import { RouteForm, routerAnswerText, routeTargetsOf } from "../../../src/flow/types/tables.js";
import { DecidedBy, SpawnPolicy, type RouterOptions } from "../../../src/flow/decorators/router.js";
import { SupportIntentDto } from "../fixtures/credit-dtos.js";
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

/** Type generation for the v2 fixtures (#272 PR 3, #270 AC13, S2–S4, S39). */

const framework = new URL("../../../", import.meta.url).pathname;
const fixtures = new URL("../fixtures/", import.meta.url).pathname;
const outFile = join(framework, GENERATED_TYPES_FILE);
const tablesModule = join(framework, "src/flow/generated-types.ts");

/** Every fixture module with its named exports — what the loader records under tsx. */
async function fixtureModules(): Promise<readonly LoadedModule[]> {
  const files = readdirSync(fixtures)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => join(fixtures, file));
  return Promise.all(
    files.map(async (file) => ({
      file,
      exports: (await import(file)) as Readonly<Record<string, unknown>>,
    })),
  );
}

const isFlowWorkflow = (value: unknown): value is Class =>
  typeof value === "function" && declarationOf(value as Class)?.kind === NodeKind.Workflow;

async function workflowsOf(files: readonly string[]): Promise<readonly Class[]> {
  const modules = await Promise.all(
    files.map(async (file) => (await import(file)) as Record<string, unknown>),
  );
  return modules.flatMap((module) => Object.values(module).filter(isFlowWorkflow));
}

async function requestFor(files: readonly string[]): Promise<FlowTypesRequest> {
  return {
    workflows: await workflowsOf(files),
    modules: await fixtureModules(),
    outFile,
    tablesModule,
  };
}

const run = promisify(execFile);

describe("#270 AC13: agboss check generates .agboss/types.d.ts for the fixtures", () => {
  it("the generated file matches its snapshot", async () => {
    const generated = generateFlowTypes(await requestFor(FIXTURE_WORKFLOWS));

    expect(generated.errors.map((found) => found.code)).toEqual([
      "launch.item-not-read",
      "flow.unused-output",
      "input.missing-on-path",
      "router.policy-with-choose-one",
    ]); // the broken workflows are broken on purpose; topics-workflow keeps policies on .chooseOne(…)
    await expect(generated.text).toMatchFileSnapshot("./__snapshots__/fixtures.types.d.ts.snap");
  });

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
  }, 60_000);
});

describe("S4: InputOf is an exact union up to 32 input shapes, flat above", () => {
  it("32 shapes: an exact union, no note; 64: one flat object and an info line", async () => {
    const generated = generateFlowTypes(await requestFor([join(fixtures, "wide.fixture.ts")]));
    const text = generated.text ?? "";
    const five = text.slice(
      text.indexOf('    "five-parts-agent":\n'),
      text.indexOf('"five-parts-workflow-start": {'),
    );

    expect(MAX_EXACT_INPUT_SHAPES).toBe(32);
    expect(five.split("\n      | ").length - 1).toBe(32);
    expect(text).toContain(
      '    "six-parts-agent": { first?: Produced<FirstPartDto, typeof SixPartsWorkflowStart>; second?: ',
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

    expect(text).toContain('    "ApprovedVerdictDto": ApprovedVerdictDto;\n');
    expect(text).toContain(
      'declare module "../tests/flow/fixtures/markers.fixture.js" {\n  interface ApprovedVerdictDto {\n    readonly [agbossDto]?: "ApprovedVerdictDto";\n  }',
    );
    expect(text).toContain(
      '  interface VerdictAgent {\n    readonly [agbossComponent]?: "verdict-agent";\n  }',
    );
  });
});

describe("#280: Route<R> and what route() returns", () => {
  it("Routes after .chooseOne(…) lists every target; RouterAnswers is written for code routers", async () => {
    const { text } = generateFlowTypes(
      await requestFor([join(fixtures, "credit.fixture.ts"), join(fixtures, "topics.fixture.ts")]),
    );

    expect(text).toContain(
      '  interface Routes {\n    "credit-limit-by-model-router": typeof ApprovalAgent | typeof ChargeCardAction;\n    "credit-limit-router": typeof ApprovalAgent | typeof ChargeCardAction;\n    "desk-router": typeof NoOrderWorkflowFinish | typeof OrderIntakeAgent;\n    "topics-router": typeof DeliveryTopicAgent | typeof OrderTopicAgent | typeof RefundTopicAgent;\n  }',
    );
    expect(text).toContain(
      '  interface RouterAnswers {\n    "credit-limit-router": typeof ApprovalAgent | typeof ChargeCardAction;\n    "topics-router": typeof DeliveryTopicAgent | typeof OrderTopicAgent | typeof RefundTopicAgent;\n  }',
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

  it("one target after .chooseOne(…); a list before a launch, non-empty without Always", () => {
    const route = "typeof A | typeof B";

    expect(routerAnswerText(route, RouteForm.One, false)).toBe(route);
    expect(routerAnswerText(route, RouteForm.List, false)).toBe(
      "readonly [(typeof A | typeof B), ...(typeof A | typeof B)[]]",
    );
    expect(routerAnswerText(route, RouteForm.List, true)).toBe("readonly (typeof A | typeof B)[]");
    expect(routerAnswerText("typeof A", RouteForm.List, true)).toBe("readonly typeof A[]");
  });
});
