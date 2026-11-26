/**
 * #1307 (G3, P6a): `PauseAnswerRecord` is part of the `@agboss/core/stores` contract, which keeps ISO 8601
 * texts until P6b. A store is handed the text `toISOString()` writes, in any process time zone — never a
 * `Date` (a driver writes one in local time with an offset, and the texts of a column stop sorting by
 * instant). A caller reads `Date`s in `result.record.pauses`.
 */
import { afterEach, describe, expect, vi } from "vitest";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import type { PauseAnswerRecord } from "../../src/flow/runtime/execution-record.js";
import { testWith } from "../../src/testing/index.js";
import { minutes } from "../../src/units/index.js";
import {
  ExtensionApplication,
  managerFlow,
  resetTold,
  told,
} from "../flow/fixtures/pause-extension.fixture.js";
import { execute } from "../helpers/flow.js";

const test = testWith(ExtensionApplication);
const manager = { actor: { id: "manager-17" } };
const ZONE = process.env.TZ;

afterEach(() => {
  if (ZONE === undefined) delete process.env.TZ;
  else process.env.TZ = ZONE;
  resetTold();
});

describe("P6a: what the answer log's store is handed", () => {
  for (const zone of ["UTC", "Asia/Jerusalem", "America/New_York"])
    test(`${zone}: the ISO texts of the instants, and the record reads Dates`, async ({
      app,
      clock,
    }) => {
      process.env.TZ = zone;
      await app.ready();
      const store = app.resolve(ExecutionRecordRepository);
      const saved: PauseAnswerRecord[] = [];
      const save = store.savePauseAnswer.bind(store);
      vi.spyOn(store, "savePauseAnswer").mockImplementation((tenantId, root, answer) => {
        saved.push(answer);
        return save(tenantId, root, answer);
      });
      await execute(app, managerFlow.start, { orderId: "o-1" }, { threadId: `text-${zone}` });
      const askedAt = clock.now();
      await clock.advance(minutes(10));
      const answeredAt = clock.now();

      const done = await app.resume(
        { pauseId: told.sent[0]?.pauseId ?? "", decision: { approved: true } },
        { ...manager, includeRecord: true },
      );

      expect(saved).toHaveLength(1);
      // texts, exactly what toISOString() writes: `toMatchObject` never equals a Date to a text
      expect(saved[0]).toMatchObject({
        askedAt: askedAt.toISOString(),
        resolvedAt: answeredAt.toISOString(),
        trail: [{ at: askedAt.toISOString() }],
      });
      expect(done.record?.pauses[0]).toMatchObject({ askedAt, resolvedAt: answeredAt });
    });
});
