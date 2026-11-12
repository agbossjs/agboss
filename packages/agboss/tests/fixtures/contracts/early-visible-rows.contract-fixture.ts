// #898 acceptance: the "seen only once the effect committed" case against stores whose business
// row is visible to another instance before its effect commits (a write on an autocommit
// connection, or a commit before the write ends), for a write that is synchronous and one that waits.
import { fencedEffectContract } from "../../../src/testing/contracts/index.js";
import type { InMemoryFencedEffectTransaction } from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryTarget, sharedInMemory } from "../../infrastructure/contracts/store-kinds.js";

type Insert = (transaction: InMemoryFencedEffectTransaction, row: string) => void;

/** `insert`, after a turn of the loop: a write that waits. */
const waitingInsert =
  (insert: Insert) =>
  async (transaction: InMemoryFencedEffectTransaction, row: string): Promise<void> => {
    await Promise.resolve();
    insert(transaction, row);
  };

/** The sound store, or (`isEarly`) one whose rows are visible the moment they are inserted. */
const storesOf = (isAsync: boolean, isEarly: boolean) =>
  inMemoryTarget((seam) => {
    const stores = inMemoryFencedEffects(isAsync)(seam);
    if (!isEarly) return stores;
    const visible = sharedInMemory(seam, "fenced-effect-rows", (): string[] => []);
    const insert: Insert = (_transaction, row) => {
      visible.push(row);
    };
    return {
      ...stores,
      rows: {
        ...stores.rows,
        insert: isAsync ? waitingInsert(insert) : insert,
      },
    };
  });

for (const [name, isAsync, isEarly] of [
  ["sound, synchronous write", false, false],
  ["sound, waiting write", true, false],
  ["visible before the commit, synchronous write", false, true],
  ["visible before the commit, waiting write", true, true],
] as const)
  fencedEffectContract({ ...storesOf(isAsync, isEarly), name });
