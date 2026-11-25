import type { Milliseconds } from "../units/index.js";
import type { ResolvedStorage } from "./settings.js";
import {
  assembledStorageOf,
  resolvedStorageOf,
  storageRetentionsOf,
  type AssembledStorage,
} from "./storage-assembly.js";

/** What an assembled application keeps of its storage declaration. */
export interface StorageFields {
  readonly storage?: AssembledStorage;
}

/** What an assembled application keeps of its storage: the components and how long its rows are kept. */
export function storageFieldsOf(storage: unknown): StorageFields & {
  readonly auditLogRetention?: Milliseconds | undefined;
  readonly ledgerEntryRetention?: Milliseconds | undefined;
} {
  const assembled = assembledStorageOf(storage);
  return assembled === undefined ? {} : { storage: assembled, ...storageRetentionsOf(assembled) };
}

/** The drivers' settings of an application's `storage` option, read from `processEnv`. */
export const resolvedStorageOfOptions = (
  storage: unknown,
  processEnv: NodeJS.ProcessEnv,
): ResolvedStorage => resolvedStorageOf(assembledStorageOf(storage), processEnv);
