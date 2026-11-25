import { describe, expect, it } from "vitest";
import {
  dtoNameProblem,
  hasKindSuffix,
  isKebabCase,
  kebabNameProblem,
  kindSuffixProblem,
  NameKind,
  resolvedName,
  suggestedName,
  toKebabCase,
} from "../../src/flow/names.js";
import { OfferDraftDto } from "./fixtures/dtos.js";

/** The name rules (#272 → Names, AC13; #270 → `[dto.name]`); the analyser reports them (PR 2). */

describe("AC13: every name ends with its kind, kebab-case", () => {
  it.each([
    ["score-summary-agent", NameKind.Agent],
    ["main-router", NameKind.Router],
    ["publish-action", NameKind.Action],
    ["chat-workflow-start", NameKind.WorkflowStart],
    ["chat-workflow-finish", NameKind.WorkflowFinish],
    ["offer-workflow", NameKind.Workflow],
  ])("accepts %s", (name, kind) => {
    expect(kindSuffixProblem(name, kind)).toBeUndefined();
  });

  it("names the decorator and the name to use", () => {
    expect(kindSuffixProblem("score-summary", NameKind.Agent)).toEqual({
      code: "name.kind-suffix",
      message: '"score-summary" on @Agent — name it "score-summary-agent"',
    });
  });

  it.each([
    ["ScoreSummaryAgent", NameKind.Agent, "score-summary-agent", "@Agent"],
    ["main_router", NameKind.Router, "main-router", "@Router"],
    ["chat-workflow-start", NameKind.Workflow, "chat-workflow-start-workflow", "@Workflow"],
    ["agent", NameKind.Agent, "agent-agent", "@Agent"],
    ["Send Offer", NameKind.Action, "send-offer-action", "@Action"],
    ["chat", NameKind.WorkflowStart, "chat-workflow-start", "@WorkflowStart"],
    ["chat", NameKind.WorkflowFinish, "chat-workflow-finish", "@WorkflowFinish"],
  ])("suggests a name for %s on %s", (name, kind, suggestion, decorator) => {
    expect(kindSuffixProblem(name, kind)?.message).toBe(
      `"${name}" on ${decorator} — name it "${suggestion}"`,
    );
  });

  it("tells kebab-case and converts to it", () => {
    expect(isKebabCase("draft-agent")).toBe(true);
    expect(isKebabCase("Draft-agent")).toBe(false);
    expect(isKebabCase("draft--agent")).toBe(false);
    expect(toKebabCase("HTMLParserAgent")).toBe("html-parser-agent");
    expect(hasKindSuffix("draft-agent", NameKind.Router)).toBe(false);
    expect(suggestedName("draft-agent", NameKind.Agent)).toBe("draft-agent");
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

  it("a NameKind of a dropped suffix is gone", () => {
    expect(Object.values(NameKind)).not.toContain("tool");
    expect(Object.values(NameKind)).not.toContain("health-check");
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
