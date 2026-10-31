import type { Milliseconds } from "../../units/index.js";

/** What a fault scenario's world runs on (#484): its database, its store set, its pods' settings. */

/** The database a fault suite runs on. */
export interface FaultDatabase {
  /** The address every pod gets (`AGBOSS_FAULT_DATABASE_URL`): a URL, or a file's path. */
  readonly url: string;
  /** Before each scenario: an empty database (a new schema, a new file). */
  readonly reset?: () => void | Promise<void>;
  /** Whether each pod reaches it through a proxy; default: when `url` is a URL with a port. */
  readonly proxy?: boolean;
}

/** What a world is made of. */
export interface FaultWorldOptions {
  readonly stores: string;
  readonly database: FaultDatabase;
  readonly timeScale: number;
}

/** What a pod of a scenario is started with. */
export interface FaultPodOptions {
  readonly shutdownTimeout?: Milliseconds;
  readonly maxConcurrentSteps?: number;
}

/** The host and port of a TCP database's URL; `undefined` for a file. */
export function tcpTargetOf(url: string): { host: string; port: number } | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.protocol === "file:" || parsed.port === "") return undefined;
  return { host: parsed.hostname, port: Number(parsed.port) };
}

/** `url` with its host and port replaced by the proxy's. */
export const throughProxy = (url: string, port: number): string => {
  const parsed = new URL(url);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(port);
  return parsed.toString();
};
