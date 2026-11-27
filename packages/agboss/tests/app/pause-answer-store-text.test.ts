/**
 * #1307 (G3, P6b): the store contract holds `Date`s — a store is handed a `PauseAnswerRecord` and a
 * `PauseAnswerEntry` with `Date`s — and SQLite keeps the `toISOString()` text of them, in any process
 * time zone (a driver would write a `Date` in local time with an offset, and the texts of a column stop
 * sorting by instant). A caller reads `Date`s in `result.record.pauses`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, vi } from "vitest";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import type { PauseAnswerRecord } from "../../src/flow/runtime/execution-record.js";
import { createSqliteTurnStore } from "../../src/turns/sqlite-store.js";
import { pauseAnswerEntryOf } from "../../src/turns/writes.js";
import { answerOf } from "../../src/testing/contracts/pause-answer-log.cases.js";
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

describe("P6b: what the answer log's store is handed", () => {
  for (const zone of ["UTC", "Asia/Jerusalem", "America/New_York"])
    test(`${zone}: Dates of the instants, and the record reads Dates`, async ({
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
      // Dates, never texts: the store writes the text of them itself
      expect(saved[0]?.askedAt).toBeInstanceOf(Date);
      expect(saved[0]).toMatchObject({ askedAt, resolvedAt: answeredAt, trail: [{ at: askedAt }] });
      expect(saved[0]?.trail[0]?.at).toBeInstanceOf(Date);
      expect(done.record?.pauses[0]).toMatchObject({ askedAt, resolvedAt: answeredAt });
    });
});

describe("P6b: what SQLite keeps of a time", () => {
  for (const zone of ["UTC", "Asia/Jerusalem", "America/New_York"])
    test(`${zone}: the answer log's raw column and JSON hold the toISOString() text`, async () => {
      process.env.TZ = zone;
      const dir = mkdtempSync(join(tmpdir(), "agboss-p6b-"));
      const path = join(dir, "turns.sqlite");
      const store = createSqliteTurnStore(path, () => new Date());
      const askedAt = new Date("2026-03-29T00:30:00.123Z");
      const answer = { ...answerOf("manager-17", true), askedAt, trail: [] };

      await store.appendPauseAnswer(pauseAnswerEntryOf("acme", "root-1", answer));
      store.close();
      const raw = new DatabaseSync(path);
      const row = raw.prepare("SELECT asked_at, record FROM pause_answers").get();
      raw.close();
      rmSync(dir, { recursive: true, force: true });

      expect(row).toMatchObject({ asked_at: "2026-03-29T00:30:00.123Z" });
      expect(JSON.parse(String((row as { record: string }).record))).toMatchObject({
        askedAt: "2026-03-29T00:30:00.123Z",
      });
    });
});
