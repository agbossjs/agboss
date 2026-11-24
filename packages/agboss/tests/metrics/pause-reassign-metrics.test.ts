/**
 * #946 with #943: a reassignment counts the old pause closed `reassigned` (once, by the call whose
 * transaction won) and the replacement opened (once it was asked) — by workflow and role; the id
 * of neither pause is a label. A refused reassignment counts nothing.
 */
import { beforeEach, describe, expect } from "vitest";
import { callTool, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import {
  DeskClerkAgent,
  DeskWorkflowStart,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "../channels/fixtures/pauses.workflow.js";
import { collect, instanceMeter, type InstanceMeter } from "./support/metric-reader.js";

const OPENED = "agboss.instance.pauses.opened";
const CLOSED = "agboss.instance.pauses.closed";
const REASSIGNED = "agboss.instance.pauses.reassigned";
const manager = { actor: { id: "manager-17" } };

beforeEach(resetPauses);

/** A metric's points as `workflow/role[/reason] → count`. */
async function countedOf(meter: InstanceMeter, name: string): Promise<Record<string, number>> {
  const counted: Record<string, number> = {};
  for (const { attributes, value } of (await collect(meter)).get(name)?.points ?? []) {
    const key = [attributes.workflow, attributes.channel, attributes.reason]
      .filter((part) => part !== undefined)
      .map(String)
      .join("/");
    counted[key] = (counted[key] ?? 0) + value;
  }
  return counted;
}

const meter = instanceMeter();
const desk = testWith(PausesApplication, { instances: [{ meterProvider: meter.provider }] });

describe("#946 with #943: a reassignment is counted", () => {
  desk(
    "the old pause closes `reassigned` once, the replacement opens once; a refused reassignment counts nothing",
    async ({ app, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      await execute(app, DeskWorkflowStart, { text: "refund order 7" });
      const oldId = seen.asks[0]?.pauseId ?? "";
      const role = "refund-approval-channel";
      expect(await countedOf(meter, OPENED)).toEqual({ [`desk-workflow/${role}`]: 1 });

      await app.reassignPause({ pauseId: oldId, assignees: ["deputy-3"] }, manager);
      await until(() => seen.asks.length === 2);
      // refused twice (the old pause is closed): counted nowhere
      await app
        .reassignPause({ pauseId: oldId, assignees: ["deputy-4"] }, manager)
        .catch(() => undefined);

      expect(await countedOf(meter, OPENED)).toEqual({ [`desk-workflow/${role}`]: 2 });
      // counted once, by the call whose transaction won: the refused one counts nothing
      expect(await countedOf(meter, REASSIGNED)).toEqual({ [`desk-workflow/${role}`]: 1 });
      expect(await countedOf(meter, CLOSED)).toEqual({
        [`desk-workflow/${role}/reassigned`]: 1,
      });
      const labels = (await collect(meter))
        .get(CLOSED)
        ?.points.flatMap((p) => Object.keys(p.attributes));
      expect(labels?.sort()).toEqual(["channel", "reason", "target", "workflow"]);
    },
  );
});
