import { InjectionToken } from "../components/injection.js";
import type { NewThreadId } from "../terns/index.js";
import { InMemoryDatabase } from "./in-memory-database.js";

/**
 * What the built-in infrastructure defaults read from their application instance (internal, never
 * exported): the time for the ledger's day, the records and the leases, the instance's id, the new
 * thread ids and the memory the in-memory defaults keep their rows in. The app registers them in
 * its container; tests give a controllable clock, deterministic ids and one database shared by
 * the instances of a test (`testWith(App, { instances: 2 })`).
 */

/** The time of the application instance (`() => new Date()` unless a test controls it). */
export const INFRASTRUCTURE_CLOCK = new InjectionToken<() => Date>("INFRASTRUCTURE_CLOCK");

/** A new thread id (random unless a test makes them deterministic). */
export const NEW_THREAD_ID = new InjectionToken<NewThreadId | undefined>("NEW_THREAD_ID");

/** The id of this application instance: the holder of the leases it takes (#265, Q58). */
export const INSTANCE_ID = new InjectionToken<string>("INSTANCE_ID");

/** Where the in-memory defaults keep their rows: one per instance, one per test in tests. */
export const IN_MEMORY_DATABASE = new InjectionToken<InMemoryDatabase>("IN_MEMORY_DATABASE");

/** All of them, as the core values every container of an application has. */
export const INFRASTRUCTURE_TOKENS = [
  INFRASTRUCTURE_CLOCK,
  NEW_THREAD_ID,
  INSTANCE_ID,
  IN_MEMORY_DATABASE,
];
