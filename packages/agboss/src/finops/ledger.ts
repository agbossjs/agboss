import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { systemClock } from "../infrastructure/clock.js";
import type { UsageRecord } from "./usage.js";

/**
 * Daily spend of one workflow (config.name). Days are UTC: the counter resets at 00:00 UTC.
 * Shared by every process that uses the same ledger.
 */
export interface SpendLedger {
  readonly spentToday: (bundle: string) => Promise<number>;
  readonly record: (bundle: string, records: readonly UsageRecord[]) => Promise<void>;
}

/** The current time, read by a ledger for its UTC day (an application's `Clock`, as a function). */
export type Now = () => Date;

const systemNow: Now = () => systemClock.now();

/** "2026-09-24" for any moment of that UTC day. */
export const utcDay = (moment: Date): string => moment.toISOString().slice(0, 10);

const EntrySchema = z.object({
  at: z.string(),
  caller: z.string(),
  model: z.string(),
  costUsd: z.number(),
});

type SpendEntry = z.infer<typeof EntrySchema>;

function costOfLine(line: string): number {
  const value: unknown = JSON.parse(line);
  return EntrySchema.parse(value).costUsd;
}

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Append-only JSONL, one file per workflow per UTC day: <dir>/<workflow>/<YYYY-MM-DD>.jsonl. */
export function createFileLedger(dir: string, now: Now = systemNow): SpendLedger {
  const fileFor = (bundle: string): string => join(dir, bundle, `${utcDay(now())}.jsonl`);
  return {
    spentToday: async (bundle) => {
      try {
        const text = await readFile(fileFor(bundle), "utf8");
        return text
          .split("\n")
          .filter(Boolean)
          .map(costOfLine)
          .reduce((sum, cost) => sum + cost, 0);
      } catch (error) {
        if (isNotFound(error)) return 0;
        throw error;
      }
    },
    record: async (bundle, records) => {
      if (records.length === 0) return;
      const at = now().toISOString();
      const lines = records.map((record): SpendEntry => ({
        at,
        caller: record.caller,
        model: record.model,
        costUsd: record.costUsd,
      }));
      await mkdir(join(dir, bundle), { recursive: true });
      await appendFile(fileFor(bundle), lines.map((line) => JSON.stringify(line) + "\n").join(""));
    },
  };
}

/** In-process ledger (tests, one-off runs): spend per workflow per UTC day of `now`. */
export function createMemoryLedger(now: Now = systemNow): SpendLedger {
  const days = new Map<string, number>();
  const keyOf = (bundle: string): string => `${bundle}/${utcDay(now())}`;
  return {
    spentToday: (bundle) => Promise.resolve(days.get(keyOf(bundle)) ?? 0),
    record: (bundle, records) => {
      const key = keyOf(bundle);
      const spent = records.reduce((sum, record) => sum + record.costUsd, 0);
      days.set(key, (days.get(key) ?? 0) + spent);
      return Promise.resolve();
    },
  };
}
