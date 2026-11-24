import { beforeEach, describe, expect } from "vitest";
import { ApplicationContext } from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { first, untilSettled } from "../../metrics/support/runs.js";
import {
  OtherWorkerApplication,
  OtherWorkerItemWorkflowFinish,
  OtherWorkerRootWorkflowStart,
  OtherWorkerUnavailableWorkflowFinish,
  otherLog,
} from "./fixtures/other-worker.workflow.js";

/** #1286 / D9: `ChildPlacement.OtherWorker` never runs on the launching instance. */

const item = { name: "a", delay: 0, outcome: "ok" };

beforeEach(() => {
  otherLog.ranOn = [];
});

describe("#1286 D9: OtherWorker with no other live worker", () => {
  const alone = testWith(OtherWorkerApplication);

  alone(
    "the parent's step fails with ChildWorkerUnavailableError after childClaimTimeout; the child never ran here",
    async ({ apps, clock }) => {
      const app = first(apps);
      const call = execute(app, OtherWorkerRootWorkflowStart, item);

      await untilSettled(call, clock);

      expect(await call).toFinishWith(OtherWorkerUnavailableWorkflowFinish, item);
      expect(otherLog.ranOn).toEqual([]);
    },
  );
});

describe("#1286: OtherWorker with another worker", () => {
  const two = testWith(OtherWorkerApplication, { instances: 2 });

  two(
    "the other instance claims it and runs it; the launcher never does",
    async ({ apps, clock }) => {
      const [a, b] = apps;
      if (a === undefined || b === undefined) throw new Error("two instances");
      await b.ready();
      await a.ready();
      const call = execute(a, OtherWorkerRootWorkflowStart, item);

      await untilSettled(call, clock);

      expect(await call).toFinishWith(OtherWorkerItemWorkflowFinish, { name: "a" });
      expect(otherLog.ranOn).toHaveLength(1);
      expect(otherLog.ranOn[0]).not.toBe(a.resolve(ApplicationContext).instanceId);
      expect(otherLog.ranOn[0]).toBe(b.resolve(ApplicationContext).instanceId);
    },
  );
});
