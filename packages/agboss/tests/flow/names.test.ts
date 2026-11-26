import { ComponentKind } from "../../src/flow/runtime/records.js";
import { describe, expect, it } from "vitest";
import {
  dtoNameProblem,
  hasKindSuffix,
  isKebabCase,
  kebabNameProblem,
  kindSuffixProblem,
  resolvedName,
  suggestedName,
  toKebabCase,
} from "../../src/flow/names.js";
import { OfferDraftDto } from "./fixtures/dtos.js";

/** The name rules (#272 → Names, AC13; #270 → `[dto.name]`); the analyser reports them (PR 2). */

describe("AC13: every name ends with its kind, kebab-case", () => {
  it.each([
    ["score-summary-agent", ComponentKind.Agent],
    ["main-router", ComponentKind.Router],
    ["publish-action", ComponentKind.Action],
    ["chat-workflow-start", ComponentKind.WorkflowStart],
    ["chat-workflow-finish", ComponentKind.WorkflowFinish],
    ["offer-workflow", ComponentKind.Workflow],
  ] as const)("accepts %s", (name, kind) => {
    expect(kindSuffixProblem(name, kind)).toBeUndefined();
  });

  it("names the decorator and the name to use", () => {
    expect(kindSuffixProblem("score-summary", ComponentKind.Agent)).toEqual({
      code: "name.kind-suffix",
      message: '"score-summary" on @Agent — name it "score-summary-agent"',
    });
  });

  it.each([
    ["ScoreSummaryAgent", ComponentKind.Agent, "score-summary-agent", "@Agent"],
    ["main_router", ComponentKind.Router, "main-router", "@Router"],
    ["chat-workflow-start", ComponentKind.Workflow, "chat-workflow-start-workflow", "@Workflow"],
    ["agent", ComponentKind.Agent, "agent-agent", "@Agent"],
    ["Send Offer", ComponentKind.Action, "send-offer-action", "@Action"],
    ["chat", ComponentKind.WorkflowStart, "chat-workflow-start", "@WorkflowStart"],
    ["chat", ComponentKind.WorkflowFinish, "chat-workflow-finish", "@WorkflowFinish"],
  ] as const)("suggests a name for %s on %s", (name, kind, suggestion, decorator) => {
    expect(kindSuffixProblem(name, kind)?.message).toBe(
      `"${name}" on ${decorator} — name it "${suggestion}"`,
    );
  });

  it("tells kebab-case and converts to it", () => {
    expect(isKebabCase("draft-agent")).toBe(true);
    expect(isKebabCase("Draft-agent")).toBe(false);
    expect(isKebabCase("draft--agent")).toBe(false);
    expect(toKebabCase("HTMLParserAgent")).toBe("html-parser-agent");
    expect(hasKindSuffix("draft-agent", ComponentKind.Router)).toBe(false);
    expect(suggestedName("draft-agent", ComponentKind.Agent)).toBe("draft-agent");
  });
});

describe("#1343a: an optional name is the class name in kebab-case", () => {
  it("takes the given name, else the class name", () => {
    const CrmHealthCheck = { name: "CrmHealthCheck" };
    expect(resolvedName("crm", CrmHealthCheck)).toBe("crm");
    expect(resolvedName(undefined, CrmHealthCheck)).toBe("crm-health-check");
    expect(resolvedName(undefined, { name: "HTMLParser" })).toBe("html-parser");
  });

  it("asks for kebab-case only, never for a kind suffix", () => {
    expect(kebabNameProblem("crm-check", "@HealthCheck")).toBeUndefined();
    expect(kebabNameProblem("crm", "@HealthCheck")).toBeUndefined();
    expect(kebabNameProblem("Crm_Check", "@HealthCheck")).toEqual({
      code: "name.not-kebab-case",
      message: '"Crm_Check" on @HealthCheck — a name is kebab-case: "crm-check"',
    });
  });

  it("an anonymous class has no name to derive: it is asked for one", () => {
    const problem = kebabNameProblem(resolvedName(undefined, { name: "" }), "@Judge");
    expect(problem?.code).toBe("name.not-kebab-case");
    expect(problem?.message).toBe(
      '@Judge has no name — a class name gives none, so pass name: "kebab-case"',
    );
  });

  it("a kind of a dropped suffix is no NameKind: a tool or a health check names no suffix", () => {
    const refused = (): void => {
      // @ts-expect-error a tool's name takes no kind suffix
      kindSuffixProblem("x", ComponentKind.Tool);
      // @ts-expect-error nor does a health check's
      kindSuffixProblem("x", ComponentKind.HealthCheck);
    };
    expect(refused).toBeTypeOf("function");
  });

  it("asks for kebab-case only, never for a kind suffix", () => {
    expect(kebabNameProblem("crm-check", "@HealthCheck")).toBeUndefined();
    expect(kebabNameProblem("crm", "@HealthCheck")).toBeUndefined();
    expect(kebabNameProblem("Crm_Check", "@HealthCheck")).toEqual({
      code: "name.not-kebab-case",
      message: '"Crm_Check" on @HealthCheck — a name is kebab-case: "crm-check"',
    });
  });

  it("an anonymous class has no name to derive: it is asked for one", () => {
    const problem = kebabNameProblem(resolvedName(undefined, { name: "" }), "@Judge");
    expect(problem?.code).toBe("name.not-kebab-case");
    expect(problem?.message).toBe(
      '@Judge has no name — a class name gives none, so pass name: "kebab-case"',
    );
  });
});

describe("#270: every DTO class ends with Dto", () => {
  it("accepts a Dto class", () => {
    expect(dtoNameProblem(OfferDraftDto)).toBeUndefined();
  });

  it("names the class to use", () => {
    class Critique {
      notes = "";
    }
    class Dto {
      value = "";
    }

    expect(dtoNameProblem(Critique)).toEqual({
      code: "dto.name",
      message: "Critique is a DTO — name it CritiqueDto",
    });
    expect(dtoNameProblem(Dto)?.code).toBe("dto.name");
  });

  it("names an anonymous class", () => {
    const anonymous = [
      class {
        value = "";
      },
    ][0];

    expect(anonymous === undefined ? undefined : dtoNameProblem(anonymous)?.message).toBe(
      "(anonymous class) is a DTO — name it (anonymous class)Dto",
    );
  });
});
