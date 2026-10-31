import fc from "fast-check";

/**
 * One fast-check seed for every property of a test file (#538 acceptance), logged at its start so
 * any run — a failing one above all — replays exactly: `FC_SEED=<n> npx vitest run <file>`.
 */
export function seededProperties(file: string): number {
  const given = process.env["FC_SEED"];
  const seed =
    given === undefined || given === "" ? Math.floor(Math.random() * 2 ** 31) : Number(given);
  fc.configureGlobal({ seed });
  console.info(`[fast-check] ${file}: seed ${String(seed)} — FC_SEED=${String(seed)} replays it`);
  return seed;
}
