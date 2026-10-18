import { createHash } from "node:crypto";
import type { Brand } from "../../../src/types/brand.js";
import { canonicalJson } from "./canonical-json.js";
import type { AgentRequest, ElementRequest, JsonObject, RouterRequest } from "./request.js";

/**
 * Spike #115 — the element fingerprint: a Merkle tree over the assembled request.
 * A leaf hashes the canonical JSON of one part; a branch hashes the ordered list of its children's
 * `[label, hash]`, so child order counts where it is meaningful (DTO fields) and is fixed by the
 * assembly where it is not (tools and routes are sorted by name before they are sent).
 */

export type Sha256Hex = Brand<string, "Sha256Hex">;

export interface FingerprintNode {
  readonly label: string;
  readonly hash: Sha256Hex;
  readonly children: readonly FingerprintNode[];
}

export type ChangeKind = "added" | "removed" | "changed" | "reordered";

export interface FingerprintChange {
  readonly path: string;
  readonly change: ChangeKind;
}

const sha256 = (text: string): Sha256Hex =>
  createHash("sha256").update(text, "utf8").digest("hex") as Sha256Hex; // branded at its source

export const leaf = (label: string, value: unknown): FingerprintNode => ({
  label,
  hash: sha256(canonicalJson(value)),
  children: [],
});

export const branch = (label: string, children: readonly FingerprintNode[]): FingerprintNode => ({
  label,
  hash: sha256(canonicalJson(children.map((child) => [child.label, child.hash]))),
  children,
});

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON Schema: one child per property in declaration order, plus everything else as `shape`. */
function schemaNode(label: string, schema: JsonObject): FingerprintNode {
  const { properties, ...shape } = schema;
  if (!isJsonObject(properties)) return leaf(label, schema);
  const fields = Object.entries(properties).map(([name, property]) =>
    isJsonObject(property) ? schemaNode(name, property) : leaf(name, property ?? null),
  );
  return branch(label, [...fields, leaf("shape", shape)]);
}

function agentNode(request: AgentRequest): FingerprintNode {
  const tools = request.tools.map((tool) =>
    branch(tool.name, [
      leaf("description", tool.description),
      schemaNode("input schema", tool.parameters),
    ]),
  );
  return branch("agent", [
    leaf("prompt", request.prompt),
    leaf("model + parameters", request.model),
    branch("tools", tools),
    request.answerSchema === null
      ? leaf("answer schema", null)
      : schemaNode("answer schema", request.answerSchema),
    leaf("request assembly", request.assemblyVersion),
  ]);
}

function routerNode(request: RouterRequest): FingerprintNode {
  return branch("router", [
    leaf("prompt", request.prompt),
    leaf("model + parameters", request.model),
    branch(
      "routes",
      request.routes.map((route) => leaf(route.name, route.prompt)),
    ),
    leaf("request assembly", request.assemblyVersion),
  ]);
}

export const fingerprintOf = (request: ElementRequest): FingerprintNode =>
  request.kind === "agent" ? agentNode(request) : routerNode(request);

/** Where two fingerprints differ, down to the smallest changed part. */
export function diffFingerprints(
  before: FingerprintNode,
  after: FingerprintNode,
  path: string = after.label,
): readonly FingerprintChange[] {
  if (before.hash === after.hash) return [];
  if (before.children.length === 0 || after.children.length === 0)
    return [{ path, change: "changed" }];
  const previous = new Map(before.children.map((child) => [child.label, child]));
  const current = new Set(after.children.map((child) => child.label));
  const changes = after.children.flatMap((child): readonly FingerprintChange[] => {
    const old = previous.get(child.label);
    const childPath = `${path} / ${child.label}`;
    return old === undefined
      ? [{ path: childPath, change: "added" }]
      : diffFingerprints(old, child, childPath);
  });
  const removed = before.children
    .filter((child) => !current.has(child.label))
    .map((child): FingerprintChange => ({ path: `${path} / ${child.label}`, change: "removed" }));
  const all = [...changes, ...removed];
  return all.length === 0 ? [{ path, change: "reordered" }] : all;
}

/** `gc suite fingerprint`-like text: the tree with short hashes and what changed since `before`. */
export function renderFingerprint(node: FingerprintNode, before?: FingerprintNode): string {
  const changes = before === undefined ? [] : diffFingerprints(before, node);
  const marks = new Map(changes.map((item) => [item.path, item.change]));
  const lines: string[] = [];
  const walk = (current: FingerprintNode, path: string, depth: number): void => {
    const mark = marks.get(path);
    const label = `${"  ".repeat(depth)}${current.label}`.padEnd(32);
    lines.push(`${label}${current.hash.slice(0, 8)}…${mark === undefined ? "" : `  ${mark}`}`);
    for (const child of current.children) walk(child, `${path} / ${child.label}`, depth + 1);
  };
  walk(node, node.label, 0);
  return lines.join("\n");
}
