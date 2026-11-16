import type { FaultStoreSabotage } from "./pod-protocol.js";
import type { Milliseconds } from "../../units/index.js";

/** What a fault scenario's cluster runs on (#484): its database, its store set, its pods' settings. */

/** The database a fault suite runs on. */
export interface FaultDatabase {
  /** The address every pod gets (`AGBOSS_FAULT_DATABASE_URL`): a URL, or a file's path. */
  readonly url: string;
  /** Before each scenario: an empty database (a new schema, a new file). */
  readonly reset?: () => void | Promise<void>;
  /** Whether each pod reaches it through a proxy; default: when `url` is a URL with a port. */
  readonly proxy?: boolean;
}

/** What a cluster is made of. */
export interface FaultClusterOptions {
  readonly storesModule: string;
  readonly database: FaultDatabase;
  readonly timeScale: number;
}

/** What a pod of a scenario is started with. */
export interface FaultPodOptions {
  readonly shutdownTimeout?: Milliseconds;
  readonly maxConcurrentSteps?: number;
  /**
   * The pod keeps the framework's store-call bound (#928; default: it does not). The scenarios
   * that freeze a pod (SIGSTOP) and release a call it held after the thaw model a store that
   * answers late; a bounded pod's overdue timers would give that call up first, and under load
   * that decides the run. The scenarios of the bound itself (22) run bounded.
   */
  readonly isBounded?: boolean;
  /**
   * The pod's application also lists the order whose question expires (#941). Only the expiry
   * scenarios ask for it: every pod's extra workflow is extra timers and writes, and a pod frozen
   * (SIGSTOP) in the middle of one holds the database's write lock for the other pods.
   */
  readonly hasExpiringOrders?: boolean;
  /** The pod's fenced-effect store broken on purpose (#959): a sabotage scenario's. */
  readonly sabotage?: FaultStoreSabotage;
  /**
   * The pod's clock off the run's (#533): `offset` ms ahead (negative: behind), running `drift`
   * faster — its wall time, monotonic time and sleeps; its stores keep the run's time.
   */
  readonly clockSkew?: { readonly offset?: number; readonly drift?: number };
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

/**
 * The bytes of a client's message that apply a write, by the database's protocol (#1017: where
 * `DatabaseProxy.dropAfter` cuts to lose a COMMIT's answer): PostgreSQL's `COMMIT`, MongoDB's
 * `commitTransaction`, Redis's `EVALSHA` (a script runs whole). `undefined` for another address.
 */
export function commitBytesOf(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  switch (new URL(url).protocol) {
    case "postgres:":
    case "postgresql:":
      return "COMMIT";
    case "mongodb:":
    case "mongodb+srv:":
      return "commitTransaction";
    case "redis:":
    case "rediss:":
      return "EVALSHA";
    default:
      return undefined;
  }
}

/** A PostgreSQL wire message field: its type byte, the text, a NUL. */
const pgField = (type: string, text: string): Buffer =>
  Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(text, "utf8"), Buffer.alloc(1)]);

/**
 * A PostgreSQL ErrorResponse: `E`, an int32 length that counts itself, the fields, a last NUL.
 * What PgBouncer sends when its server connection breaks: FATAL, SQLSTATE 08P01
 * (protocol_violation), "server conn crashed?". `node-postgres` delivers it as a `DatabaseError`
 * with `code` 08P01 on the active query (#1017).
 */
const postgresProtocolError = (): Uint8Array => {
  const body = Buffer.concat([
    pgField("S", "FATAL"),
    pgField("V", "FATAL"),
    pgField("C", "08P01"),
    pgField("M", "server conn crashed?"),
    Buffer.alloc(1),
  ]);
  const header = Buffer.alloc(5);
  header.write("E", 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

/**
 * The bytes a client reads instead of the database's answer to a COMMIT, by the database's
 * protocol (#1017: `DatabaseProxy.answerAfter`): a server error that is none of a reset's. For
 * PostgreSQL a pooler's protocol error (08P01); `undefined` for another address (MongoDB, Redis:
 * no exact server-error frame built).
 */
export function protocolErrorBytesOf(url: string): Uint8Array | undefined {
  if (!URL.canParse(url)) return undefined;
  switch (new URL(url).protocol) {
    case "postgres:":
    case "postgresql:":
      return postgresProtocolError();
    default:
      return undefined;
  }
}
