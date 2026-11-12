import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { LiveCallBlockedError } from "./errors.js";

/** One test's network rules: the hosts it may reach, where a blocked call is reported. */
export interface NetworkPolicy {
  readonly allowed: readonly string[];
  readonly onBlocked: (error: LiveCallBlockedError) => void;
}

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "[::1]"];

/** `localhost` stands for every loopback address. */
const expand = (hosts: readonly string[]): string[] =>
  hosts.flatMap((host) => (LOOPBACK.includes(host) ? LOOPBACK : [host]));

const active = new Set<NetworkPolicy>();
let restore: (() => void) | undefined;

/** A host one of the allowed hosts covers. */
export const isHostAllowed = (allowed: readonly string[], host: string): boolean =>
  expand(allowed).includes(host);

/** A request to a host no active test allows: the failure, reported to every active test. */
function blocked(host: string, via: string): LiveCallBlockedError | undefined {
  if ([...active].some((policy) => isHostAllowed(policy.allowed, host))) return undefined;
  const error = new LiveCallBlockedError({
    message: `${via} to ${host} — the network is blocked in tests; allow it with testWith(…, { allowNetwork: ["${host}"] })`,
  });
  active.forEach((policy) => {
    policy.onBlocked(error);
  });
  return error;
}

/** The host of `http.request(url | options, …)`. */
export function hostOf(target: unknown): string {
  if (typeof target === "string") return new URL(target).hostname;
  if (target instanceof URL) return target.hostname;
  if (typeof target === "object" && target !== null) {
    if ("hostname" in target && typeof target.hostname === "string") return target.hostname;
    if ("host" in target && typeof target.host === "string")
      return target.host.replace(/:\d+$/, "");
  }
  return "localhost";
}

/** The host of `fetch(url | Request, …)`. */
export const fetchHostOf = (input: unknown): string =>
  input instanceof Request ? new URL(input.url).hostname : hostOf(input);

/** The same function, checked before every call; a blocked fetch rejects instead of throwing. */
function guarded<TFn extends (...args: never[]) => unknown>(
  original: TFn,
  via: string,
  hostFrom: (arg: unknown) => string,
): TFn {
  return new Proxy(original, {
    apply(target, thisArg: unknown, args: unknown[]): unknown {
      const failure = blocked(hostFrom(args[0]), via);
      if (failure === undefined) return Reflect.apply(target, thisArg, args);
      if (via === "fetch") return Promise.reject(failure);
      throw failure;
    },
  });
}

/** Replaces fetch and node:http(s) `request` / `get`; returns how to put the originals back. */
function patch(): () => void {
  const originals = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };
  globalThis.fetch = guarded(originals.fetch, "fetch", fetchHostOf);
  http.request = guarded(originals.httpRequest, "http.request", hostOf);
  http.get = guarded(originals.httpGet, "http.get", hostOf);
  https.request = guarded(originals.httpsRequest, "https.request", hostOf);
  https.get = guarded(originals.httpsGet, "https.get", hostOf);
  syncBuiltinESMExports();
  return () => {
    globalThis.fetch = originals.fetch;
    http.request = originals.httpRequest;
    http.get = originals.httpGet;
    https.request = originals.httpsRequest;
    https.get = originals.httpsGet;
    syncBuiltinESMExports();
  };
}

/** Blocks the network for one test (every host but `policy.allowed`); returns how to unblock. */
export function blockNetwork(policy: NetworkPolicy): () => void {
  active.add(policy);
  restore ??= patch();
  return () => {
    active.delete(policy);
    if (active.size === 0) {
      restore?.();
      restore = undefined;
    }
  };
}
