import { FileFetches } from "./a2a-file-fetches.js";
import type { FileTransport } from "./a2a-file-transport.js";

/**
 * The internal seam of a listener's file fetch (#859): the transport a file by `url` is fetched
 * with — the built-in `node:https` one (the guarded lookup) unless a test's listener options carry
 * its own under this symbol (`withFileTransport`), as `INBOUND_MESH` rides execution options.
 */
const FILE_TRANSPORT = Symbol("agboss.a2a.file-transport");

/** Listener options with a test's own file transport. */
export const withFileTransport = <T extends object>(options: T, transport: FileTransport): T => ({
  ...options,
  [FILE_TRANSPORT]: transport,
});

/** The transport the options carry; `undefined`: the built-in one. */
export const fileTransportOf = (options: object): FileTransport | undefined => {
  const found: unknown = Reflect.get(options, FILE_TRANSPORT);
  return typeof found === "function" ? (found as FileTransport) : undefined;
};

const FILE_FETCHES = Symbol("agboss.a2a.file-fetches");

/** Listener options with a test's own fetches in flight (#904: to see a duplicate join one). */
export const withFileFetches = <T extends object>(options: T, fetches: FileFetches): T => ({
  ...options,
  [FILE_FETCHES]: fetches,
});

/** The fetches in flight the options carry; a new set by default. */
export const fileFetchesOf = (options: object): FileFetches => {
  const found: unknown = Reflect.get(options, FILE_FETCHES);
  return found instanceof FileFetches ? found : new FileFetches();
};
