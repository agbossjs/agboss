import { A2ACardFileFields } from "../a2a/files/a2a-file-options.js";
import { A2AReply } from "../a2a/a2a-expose.decorator.js";
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

/** #812: a snapshot written before names the skill `start` — the same id, the start's name. */
const A2A_EXPORT = z
  .object({
    kind: z.literal("a2a"),
    expose: z.string(),
    version: z.string(),
    skill: z.string().optional(),
    start: z.string().optional(),
    workflow: z.string(),
    input: DTO.nullable(),
    outputs: z.array(DTO.extend({ finish: z.string() })),
    // #860: a snapshot written before it has no reply — its skills answered with tasks
    reply: z.enum(A2AReply).default(A2AReply.Task),
    // #904: a snapshot written before it has none — its card's file fields as by default
    cardFileFields: z.enum(A2ACardFileFields).default(A2ACardFileFields.Extension),
  })
  .refine((entry) => entry.skill !== undefined || entry.start !== undefined, {
    path: ["skill"],
    message: "Invalid input: expected string, received undefined",
  })
  .transform(({ start, skill, ...rest }) => ({ ...rest, skill: skill ?? start ?? "" }));

const MCP_EXPORT = z.object({
  kind: z.literal("mcp"),
  expose: z.string(),
  version: z.string(),
  tool: z.string(),
  input: DTO.nullable(),
});

/** #812: a snapshot written before has `target.start` for `target.skill` and no `foreign`. */
const A2A_IMPORT = z
  .object({
    kind: z.literal("a2a"),
    client: z.string(),
    foreign: z.literal(false).default(false),
    target: z.object({
      application: z.string(),
      skill: z.string().optional(),
      start: z.string().optional(),
      finishes: z.array(z.string()).optional(),
    }),
    usedBy: z.array(USE),
    input: DTO,
    output: DTO,
    price: z.number().nullable(),
  })
  .refine((entry) => entry.target.skill !== undefined || entry.target.start !== undefined, {
    path: ["target", "skill"],
    message: "Invalid input: expected string, received undefined",
  })
  .transform(({ target: { start, skill, ...target }, ...rest }) => ({
    ...rest,
    target: { ...target, skill: skill ?? start ?? "" },
  }));

/** #812: a peer that is not an AGBoss application, listed and never compared. */
const A2A_FOREIGN_IMPORT = z.object({
  kind: z.literal("a2a"),
  client: z.string(),
  foreign: z.literal(true),
  target: z.null(),
  usedBy: z.array(USE),
  input: DTO.nullable(),
  output: DTO.nullable(),
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
        exports: z.array(z.union([A2A_EXPORT, MCP_EXPORT])),
        imports: z.array(z.union([A2A_IMPORT, A2A_FOREIGN_IMPORT, MCP_IMPORT])),
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
