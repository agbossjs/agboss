import { ComponentKind } from "../../src/flow/runtime/records.js";
import { describe, expect, it } from "vitest";
import { Injectable } from "../../src/components/decorators.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import {
  ComponentRegistry,
  DtoRegistry,
  NameRegistry,
  dtoClashMessage,
} from "../../src/flow/registry.js";
import { DraftAgent, EditorAgent } from "./fixtures/offer.fixture.js";
import { OfferDraftDto, ShortlistDto } from "./fixtures/dtos.js";
import { inline } from "../../src/index.js";

/** The registries of an application (S5): components by `name`, DTOs by class name. */

describe("S5: components by name", () => {
  it("finds a registered component by its name", () => {
    const registry = new ComponentRegistry();

    expect(registry.register(DraftAgent)).toBeUndefined();
    expect(registry.register(EditorAgent)).toBeUndefined();

    expect(registry.get("draft-agent")).toMatchObject({
      name: "draft-agent",
      component: DraftAgent,
      declaration: { kind: ComponentKind.Agent },
    });
    expect(registry.get("unknown-agent")).toBeUndefined();
    expect(registry.names).toEqual(["draft-agent", "editor-agent"]);
  });

  it("registering a class twice is not a clash; another class under the name is", () => {
    @Agent({
      name: "draft-agent",
      description: "A second draft agent",
      prompt: inline("Draft."),
      model: "moonshotai/kimi-k2.6",
    })
    class SecondDraftAgent {}
    const registry = new ComponentRegistry();
    registry.register(DraftAgent);

    expect(registry.register(DraftAgent)).toBeUndefined();
    expect(registry.register(SecondDraftAgent)).toMatchObject({
      name: "draft-agent",
      registered: { component: DraftAgent },
      clashing: { component: SecondDraftAgent },
    });
    expect(registry.get("draft-agent")?.component).toBe(DraftAgent);
  });

  it("skips a class without a v2 decorator", () => {
    @Injectable()
    class PlainService {}
    const registry = new ComponentRegistry();

    expect(registry.register(PlainService)).toBeUndefined();
    expect(registry.names).toEqual([]);
  });
});

describe("S5: DTOs by class name", () => {
  it("finds a DTO class by its name", () => {
    const registry = new DtoRegistry();
    registry.register(OfferDraftDto, "src/offer/offer-draft.dto.ts");
    registry.register(ShortlistDto);

    expect(registry.get("OfferDraftDto")).toBe(OfferDraftDto);
    expect(registry.get("MissingDto")).toBeUndefined();
    expect(registry.names).toEqual(["OfferDraftDto", "ShortlistDto"]);
  });

  it("[dto.duplicate-name] names both files", () => {
    const registry = new DtoRegistry();
    const first = class ResultDto {
      id = "";
    };
    const second = class ResultDto {
      id = "";
    };
    registry.register(first, "src/search/result.dto.ts");

    const clash = registry.register(second, "src/offer/result.dto.ts");

    expect(clash === undefined ? undefined : dtoClashMessage(clash)).toBe(
      "ResultDto is declared in src/search/result.dto.ts and src/offer/result.dto.ts — " +
        "DTO names are unique in the application (they key checkpoints)",
    );
  });

  it("says when a file is unknown", () => {
    const registry = new DtoRegistry();
    const first = class ResultDto {
      id = "";
    };
    const second = class ResultDto {
      id = "";
    };
    registry.register(first);

    const clash = registry.register(second);

    expect(clash === undefined ? undefined : dtoClashMessage(clash)).toContain(
      "(unknown file) and (unknown file)",
    );
  });
});

describe("NameRegistry is generic over names and entries", () => {
  it("keeps the first entry under a name", () => {
    const registry = new NameRegistry<string, number>((first, second) => first === second);

    expect(registry.add("one", 1)).toBeUndefined();
    expect(registry.add("one", 1)).toBeUndefined();
    expect(registry.add("one", 2)).toEqual({ name: "one", registered: 1, clashing: 2 });
    expect(registry.get("one")).toBe(1);
  });
});
