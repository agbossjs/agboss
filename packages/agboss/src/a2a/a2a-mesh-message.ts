import { createHash } from "node:crypto";
import { stableJson } from "../turns/index.js";
import { A2A_MESH_EXTENSION } from "./a2a-extension-uris.js";

/**
 * The mesh envelope on the A2A v1.0 wire (#809, design §3 "mesh envelope"), one module for the
 * client that writes it and the server that reads it: the compact JWS travels in
 * `message.metadata["https://agboss.dev/a2a/mesh/v1"].envelope` (the `A2A-Extensions` header
 * activates the extension), and its `bodyHash` binds the message — the canonical JSON of the
 * message as sent on the wire with that one metadata entry removed (and `metadata` itself when it
 * is then empty), so the SDK's own serialisation cannot break it and a resend with a fresh envelope
 * keeps the hash. The run report comes back in `task.metadata[uri].report`.
 */

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The wire JSON of a message without its mesh entry: what the envelope's `bodyHash` covers. */
export function meshSignedPartOf(message: unknown): unknown {
  if (!isRecord(message)) return message;
  const { metadata, ...rest } = message;
  // none, or one that is no map: nothing of the mesh to remove (an absent key hashes as none)
  if (!isRecord(metadata)) return message;
  const others = Object.fromEntries(
    Object.entries(metadata).filter(([uri]) => uri !== A2A_MESH_EXTENSION),
  );
  return Object.keys(others).length === 0 ? rest : { ...rest, metadata: others };
}

/** `sha256:<hex>` of a message's wire JSON, its mesh entry removed. */
export const meshBodyHashOf = (message: unknown): string =>
  `sha256:${createHash("sha256")
    .update(stableJson(meshSignedPartOf(message)))
    .digest("hex")}`;

/** The encoded envelope a message's wire JSON carries; `undefined` when it carries none. */
export function meshEnvelopeTextOf(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.metadata)) return undefined;
  const entry = message.metadata[A2A_MESH_EXTENSION];
  return isRecord(entry) && typeof entry.envelope === "string" ? entry.envelope : undefined;
}

/** The encoded run report a task's wire JSON (or SDK task) carries; `undefined` without one. */
export function meshReportTextOf(task: unknown): string | undefined {
  if (!isRecord(task) || !isRecord(task.metadata)) return undefined;
  const entry = task.metadata[A2A_MESH_EXTENSION];
  return isRecord(entry) && typeof entry.report === "string" ? entry.report : undefined;
}
