import { z } from "zod";
import type { ContractsSnapshot } from "../describe/contracts-types.js";
import type { FederationMember } from "./federation-types.js";

/**
 * A neighbour's `agboss describe --json` output read as a member of the federation (#398 PR 4):
 * the envelope `{ schema: 1, ok, command: "describe", result: { application: { name, version,
 * contracts } } }` — only what the check compares is validated, the rest ignored. Anything else →
 * the reason, never a guess (`[federation.snapshot-schema]`).
 */

const DTO = z.object({ dto: z.string(), schemaHash: z.string() });
const USE = z.object({ workflow: z.string(), tool: z.string() });

const A2A_EXPORT = z.object({
  kind: z.literal("a2a"),
  expose: z.string(),
  version: z.string(),
  start: z.string(),
  workflow: z.string(),
  input: DTO.nullable(),
  outputs: z.array(DTO.extend({ finish: z.string() })),
});

const MCP_EXPORT = z.object({
  kind: z.literal("mcp"),
  expose: z.string(),
  version: z.string(),
  tool: z.string(),
  input: DTO.nullable(),
});

const A2A_IMPORT = z.object({
  kind: z.literal("a2a"),
  client: z.string(),
  target: z.object({ application: z.string(), start: z.string() }),
  usedBy: z.array(USE),
  input: DTO,
  output: DTO,
  price: z.number().nullable(),
});

const MCP_IMPORT = z.object({
  kind: z.literal("mcp"),
  server: z.string(),
  tool: z.string(),
  target: z.object({ application: z.string(), expose: z.string() }).nullable(),
  usedBy: z.array(USE),
  input: DTO,
  output: DTO,
});

const SNAPSHOT = z.object({
  schema: z.literal(1),
  command: z.literal("describe"),
  result: z.object({
    application: z.object({
      name: z.string(),
      version: z.string(),
      contracts: z.object({
        exports: z.array(z.discriminatedUnion("kind", [A2A_EXPORT, MCP_EXPORT])),
        imports: z.array(z.discriminatedUnion("kind", [A2A_IMPORT, MCP_IMPORT])),
        schemas: z.record(
          z.string(),
          z.object({ schemaHash: z.string(), jsonSchema: z.record(z.string(), z.unknown()) }),
        ),
      }),
    }),
  }),
});

/** The member a snapshot file describes, or why it is not a `describe --json` snapshot. */
export type SnapshotReading =
  | { readonly kind: "member"; readonly member: FederationMember }
  | { readonly kind: "invalid"; readonly reason: string };

/** Reads one snapshot file's text (`file` names it in the member and in the reason). */
export function federationMemberOf(text: string, file: string): SnapshotReading {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "not JSON — save it with agboss describe --json" };
  }
  const parsed = SNAPSHOT.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` at ${issue.path.join(".") || "the top"}`;
    return {
      kind: "invalid",
      reason: `not an agboss describe --json snapshot with contracts${where} (${issue?.message ?? "invalid"})`,
    };
  }
  const { name, version, contracts } = parsed.data.result.application;
  const snapshot: ContractsSnapshot = contracts;
  return { kind: "member", member: { name, version, file, contracts: snapshot } };
}
