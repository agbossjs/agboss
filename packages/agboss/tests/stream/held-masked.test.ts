/**
 * #1311b: a held answer is released as the answer the checks read — masked by the agent's PII
 * policies — never as the model's own tokens; an answer no policy changed goes out as it came.
 */
import { describe, expect } from "vitest";
import { StreamEventKind, type ExecutionStreamEvent } from "../../src/run/types.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  MaskedHeldAgent,
  MaskedHeldApplication,
  MaskedHeldStart,
  PlainHeldAgent,
  PlainHeldStart,
} from "./held-masked.fixture.js";

const test = testWith(MaskedHeldApplication);

const shown = (events: readonly ExecutionStreamEvent[]): string =>
  events
    .flatMap((event) => (event.kind === StreamEventKind.TextDelta ? [event.delta] : []))
    .join("");

describe("#1311b: a held stream carries the masked answer", () => {
  test("an email in the answer is masked in the stream, whole, after the checks passed", async ({
    app,
    mockModel,
  }) => {
    mockModel(MaskedHeldAgent).thenReturn(replyWith("Write to ann@example.com today."));
    const events: ExecutionStreamEvent[] = [];

    await execute(app, MaskedHeldStart, { text: "Q" }, { onStream: (event) => events.push(event) });

    expect(shown(events)).not.toContain("ann@example.com");
    expect(shown(events)).toContain("<email>");
  });

  test("an answer the policies did not change goes out as the model wrote it", async ({
    app,
    mockModel,
  }) => {
    mockModel(PlainHeldAgent).thenReturn(replyWith("Nothing private here."));
    const events: ExecutionStreamEvent[] = [];

    await execute(app, PlainHeldStart, { text: "Q" }, { onStream: (event) => events.push(event) });

    expect(shown(events)).toBe("Nothing private here.");
  });
});
