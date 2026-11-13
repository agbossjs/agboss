/** #1004 AC1, AC2: the PII detection model's answer — the raw value it found — never reaches the stream. */
import { describe, expect } from "vitest";
import { replyWith, routeTo, testWith } from "../../src/testing/index.js";
import type { ExecutionStreamEvent } from "../../src/run/types.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "../pii/boundary.helpers.js";
import {
  DeskAgent,
  DeskRouter,
  DeskStart,
  NamesPiiPolicy,
  SensitiveApplication,
} from "../pii/sensitive.fixture.js";
import { deltas } from "./writer.fixture.js";

const test = testWith(SensitiveApplication);
const FOUND = '{"found":[{"kind":"person-name","text":"Dana Cohen"}]}';

describe("#1004: the PII detection model is silent", () => {
  test("AC1, AC2: neither the detector's JSON nor the value it found is on the stream", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(NamesPiiPolicy).thenAnswer((request) =>
      replyWith(requestText(request).includes("Dana Cohen") ? FOUND : '{"found":[]}'),
    );
    mockLlm(DeskRouter).thenReturn(routeTo(DeskAgent));
    mockLlm(DeskAgent).thenReturn(replyWith("ok"));
    const events: ExecutionStreamEvent[] = [];

    await execute(
      app,
      DeskStart,
      { text: "Dana Cohen asks for a refund" },
      { onStream: (event) => events.push(event) },
    );

    expect(mockLlm(NamesPiiPolicy).requests.length).toBeGreaterThan(0);
    expect(deltas(events)).toEqual(["ok"]);
    expect(JSON.stringify(events)).not.toContain("Dana Cohen");
  });
});
