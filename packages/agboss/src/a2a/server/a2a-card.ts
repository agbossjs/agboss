import { createHash } from "node:crypto";
import { AgentCard, type AgentExtension, type SecurityScheme } from "@a2a-js/sdk";
import { isoDurationOf } from "../../mesh/mesh-durations.js";
import { A2A_MESH_EXTENSION, A2A_SKILLS_EXTENSION } from "../a2a-extension-uris.js";
import { skillOptionsOf, type A2AEndpointMeta } from "../a2a-endpoint.decorator.js";
import { HttpSecuritySchemeKind, type HttpSecurityScheme } from "../../http/http-security.js";
import { cardSkillInputOf, cardSkillOutputsOf } from "./a2a-card-files.js";
import { A2AMediaType, type ServedSkill } from "./a2a-skills.js";

/**
 * The Agent Card of a listener (#808, spec §4.4 and §8): served at
 * `<base>/.well-known/agent-card.json`, built once from the `@A2AEndpoint`, its skills and the
 * listener's public URL — the JSON-RPC 1.0 binding only, streaming, no push notifications, the
 * skills extension with each skill's schemas, the mesh extension (#810: how long a `messageId` is
 * deduplicated, what makes the listener an AGBoss peer to a client), and the declared security
 * schemes of the listener's `@HttpAuthenticator`.
 */

/** The A2A version this listener serves. */
export const A2A_VERSION = "1.0";

/** The well-known path of an agent's card, below its base. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/** What a card is built from. */
export interface AgentCardSource {
  readonly expose: A2AEndpointMeta;
  readonly skills: readonly ServedSkill[];
  readonly application: string;
  /** Where the JSON-RPC endpoint is: `publicUrl` + `base`. */
  readonly url: string;
  /**
   * How long a `messageId` is deduplicated (#810): a finished task, with its messages, is kept this
   * long (the endpoint's `ttl.tasks`); an unfinished one never goes.
   */
  readonly idempotencyRetention: number;
  /**
   * How long a direct-reply skill's `messageId` is deduplicated (#860): its reply is kept this long
   * (the endpoint's `ttl.messages`) — what a client's resend of one relies on.
   */
  readonly messageIdempotencyRetention: number;
  /** When the card was made (the listener's first request): its `Last-Modified` (#811). */
  readonly madeAt: Date;
  /** Who runs the agent (`a2aHttpListener({ provider })`). */
  readonly provider?: { readonly organization: string; readonly url: string };
  /** How callers authenticate (`@HttpAuthenticator({ schemes })`): the card's `securitySchemes`. */
  readonly schemes: readonly HttpSecurityScheme[];
}

/** The card as served: its JSON text, its entity tag and when it was made (an HTTP date). */
export interface ServedAgentCard {
  readonly card: AgentCard;
  readonly json: string;
  readonly etag: string;
  readonly lastModified: string;
}

function schemeOf(scheme: HttpSecurityScheme): SecurityScheme {
  switch (scheme.kind) {
    case HttpSecuritySchemeKind.Bearer:
      return {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: { description: "", scheme: "Bearer", bearerFormat: scheme.bearerFormat ?? "" },
        },
      };
    case HttpSecuritySchemeKind.ApiKey:
      return {
        scheme: {
          $case: "apiKeySecurityScheme",
          value: { description: "", location: "header", name: scheme.header },
        },
      };
    case HttpSecuritySchemeKind.OAuth2ClientCredentials:
      return {
        scheme: {
          $case: "oauth2SecurityScheme",
          value: {
            description: "",
            oauth2MetadataUrl: "",
            flows: {
              flow: {
                $case: "clientCredentials",
                value: { tokenUrl: scheme.tokenUrl, refreshUrl: "", scopes: { ...scheme.scopes } },
              },
            },
          },
        },
      };
    case HttpSecuritySchemeKind.MutualTls:
      return { scheme: { $case: "mtlsSecurityScheme", value: { description: "" } } };
  }
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** What a skill's messages carry (#859: and the media types of the files it takes). */
const inputModesOf = (skill: ServedSkill): string[] =>
  unique([
    skill.inputMediaType,
    ...(skill.inputFiles.length === 0 ? [] : skill.fileLimits.allowedMediaTypes),
  ]);

/**
 * What a skill's finishes give: a file finish the media types its files may be (#859; #904: what
 * `Files.save` takes, the application's), its data JSON.
 */
const outputModesOf = (skill: ServedSkill): string[] =>
  unique(
    skill.outputs.flatMap((output) =>
      output.fileFields.length === 0
        ? [output.mediaType]
        : [...skill.outputFileMediaTypes, ...(output.hasData ? [A2AMediaType.Json] : [])],
    ),
  );

/** The skills extension's params: each skill's input and finishes' JSON Schemas. */
function skillsParamsOf(skills: readonly ServedSkill[]): Record<string, unknown> {
  const entries = skills.map((skill) => [
    skill.id,
    {
      // #904, #916: its file fields as its card describes them, never asked for in a data part
      ...cardSkillInputOf(skill),
      schemaHash: skill.inputSchemaHash,
      reply: skill.reply,
      ...cardSkillOutputsOf(skill),
    },
  ]);
  return { skills: Object.fromEntries(entries) };
}

/** The card's two extensions: the mesh (an AGBoss peer's), the skills' schemas. */
const extensionsOf = (source: AgentCardSource): AgentExtension[] => [
  {
    uri: A2A_MESH_EXTENSION,
    description:
      "The AGBoss mesh: the caller's signed envelope in message.metadata[uri].envelope (call chain, budget, deadline), the signed run report in task.metadata[uri].report (a direct reply's in message.metadata[uri].report)",
    required: false,
    params: {
      idempotencyRetention: isoDurationOf(source.idempotencyRetention),
      messageIdempotencyRetention: isoDurationOf(source.messageIdempotencyRetention),
    },
  },
  {
    uri: A2A_SKILLS_EXTENSION,
    description:
      "The skills' input and output JSON Schemas and how each answers (reply: task | message); message.metadata[uri].skill names the skill a message runs",
    required: false,
    params: skillsParamsOf(source.skills),
  },
];

/** The card of a listener. */
export function agentCardOf(source: AgentCardSource): ServedAgentCard {
  const { expose, skills, application } = source;
  const security = source.schemes;
  const card: AgentCard = {
    name: expose.name,
    description: expose.description,
    supportedInterfaces: [
      {
        url: source.url,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_VERSION,
      },
    ],
    provider: source.provider === undefined ? undefined : { ...source.provider },
    version: expose.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: extensionsOf(source),
    },
    securitySchemes: Object.fromEntries(security.map((scheme) => [scheme.name, schemeOf(scheme)])),
    // any one of the declared schemes
    securityRequirements: security.map((scheme) => ({ schemes: { [scheme.name]: { list: [] } } })),
    defaultInputModes: unique(skills.flatMap(inputModesOf)),
    defaultOutputModes: unique(skills.flatMap(outputModesOf)),
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.id,
      description: skill.description,
      tags: [...(skillOptionsOf(expose, skill.id)?.tags ?? [application])],
      examples: [...(skillOptionsOf(expose, skill.id)?.examples ?? [])],
      inputModes: inputModesOf(skill),
      outputModes: outputModesOf(skill),
      securityRequirements: [],
    })),
    signatures: [],
  };
  const json = JSON.stringify(AgentCard.toJSON(card));
  const etag = `"${createHash("sha256").update(json).digest("base64url")}"`;
  return { card, json, etag, lastModified: source.madeAt.toUTCString() };
}
