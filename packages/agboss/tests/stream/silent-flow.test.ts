/** #1004 AC1: the internal kinds stay silent in an agent chain; an agent with an output DTO streams no text. */
import { describe, expect } from "vitest";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { canaries, useCanary } from "./canary.js";
import {
  Closer,
  ColorDto,
  Editor,
  FlowJudge,
  LaunchColor,
  LaunchShape,
  ShapeDto,
  ShapeJudge,
  Shaper,
} from "./agents.fixture.js";
import { ChainStart, LaunchStart, ShapeStart, StreamFlowApplication } from "./flow.fixture.js";
import { deltas } from "./writer.fixture.js";

useCanary();
const test = testWith(StreamFlowApplication);

describe("#1004: structures", () => {
  test("AC1: an agent chain: the DTO agent streams nothing, the text agent its answer, no judge", async ({
    app,
    mockModel,
  }) => {
    mockModel(Shaper).thenReturn(replyWith(ShapeDto, { shape: "round" }));
    mockModel(Editor).thenReturn(replyWith("An edit."));
    mockModel(FlowJudge).thenReturnAlways(replyWith("PASS: INTERNAL"));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ChainStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ text: "An edit." });
    expect(mockModel(FlowJudge).requests).toHaveLength(1);
    expect(deltas(events)).toEqual(["CANARY", "An edit."]); // the DTO agent: none; the judge: none
  });

  test("AC1: an agent with an output DTO streams no text", async ({ app, mockModel }) => {
    mockModel(Shaper).thenReturn(replyWith(ShapeDto, { shape: "round" }));
    const events: ExecutionStreamEvent[] = [];

    const done = await execute(
      app,
      ShapeStart,
      { text: "Q" },
      { onStream: (event) => events.push(event) },
    );

    expect(done.output).toEqual({ shape: "round" });
    expect(events).toEqual([]);
  });
});

describe("#1004: parallel launch branches", () => {
  test("AC1: the branches' DTO agents and the branch judge are silent; the closing agent streams", async ({
    app,
    mockModel,
  }) => {
    mockModel(LaunchShape).thenReturn(replyWith(ShapeDto, { shape: "round" }));
    mockModel(LaunchColor).thenReturn(replyWith(ColorDto, { color: "red" }));
    mockModel(ShapeJudge).thenReturn(replyWith("PASS: INTERNAL"));
    mockModel(Closer).thenReturn(replyWith("Done."));
    const events: ExecutionStreamEvent[] = [];

    await execute(app, LaunchStart, { text: "Q" }, { onStream: (event) => events.push(event) });

    expect(mockModel(ShapeJudge).requests).toHaveLength(1);
    expect(deltas(events)).toEqual(["CANARY", "Done."]);
  });
});
