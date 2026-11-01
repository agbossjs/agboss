/**
 * #635 AC1 — a takeover before the undo: the instance holding the tree dies at its gate; the
 * instance that takes it over runs the step again, which fails, so the pass that fails — and
 * undoes — is the new holder's own. Its kept record lists the undos, as its error event does.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { kill } from "../infrastructure/fixtures/recovery.workflow.js";
import { UndoDesk, UndoDeskError } from "../flow/runtime/fixtures/undo.workflow.js";
import { UnwindGate, UnwindWorkflowStart } from "../flow/runtime/fixtures/unwind.workflow.js";
import { instance } from "./fixtures/fence-takeover.js";
import { KeptUndoApplication } from "./fixtures/kept-undo.application.js";
import {
  GUEST,
  heldUntilAborted,
  keptAsTheEvent,
  resetKeptUndo,
  ROOM,
  SEAT,
  THREAD,
} from "./fixtures/kept-undo.js";

const pair = testWith(KeptUndoApplication, { instances: 2 });

beforeEach(resetKeptUndo);

describe("#635: the pass that fails is the new holder's", () => {
  pair("its record lists the room and the seat undone", async ({ apps, clock, mockOf }) => {
    mockOf(UndoDesk).reserve.mockImplementation((kind: string) => Promise.resolve(`${kind}-1`));
    const gate = mockOf(UnwindGate);
    gate.wait.mockImplementationOnce(heldUntilAborted).mockRejectedValue(new UndoDeskError("down"));
    const [first, second] = [instance(apps, 0), instance(apps, 1)];
    await first.ready();
    await second.ready();
    const run = execute(first, UnwindWorkflowStart, GUEST, THREAD);
    run.catch(() => undefined);
    await vi.waitFor(() => {
      expect(gate.wait.mock.calls).toHaveLength(1);
    });

    kill("instance-1");
    await clock.advance(seconds(10));
    await expect(run).rejects.toBeInstanceOf(ExecutionLeaseLostError);
    await clock.advance(seconds(21));

    expect(await keptAsTheEvent(second, "failed")).toEqual([ROOM, SEAT]);
    expect(gate.wait.mock.calls).toHaveLength(2);
  });
});
