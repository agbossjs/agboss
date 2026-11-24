import type { AgentCard, AgentSkill } from "@a2a-js/sdk";
import type { A2AAgentCard, A2AAgentSkill } from "../a2a-types.js";
import { listOf, metadataOf, present, textPresent } from "./a2a-public-map.js";

/** An agent's card as AGBoss gives it (#1320): the SDK's shape ends here. */

const skillOf = (skill: AgentSkill): A2AAgentSkill => ({
  id: skill.id,
  name: skill.name,
  description: skill.description,
  tags: [...listOf(skill.tags)],
  examples: [...listOf(skill.examples)],
  inputModes: [...listOf(skill.inputModes)],
  outputModes: [...listOf(skill.outputModes)],
});

/** An agent's card as AGBoss gives it. */
export function a2aCardOf(card: AgentCard): A2AAgentCard {
  const { capabilities, provider } = card;
  return {
    name: card.name,
    description: card.description,
    version: card.version,
    supportedInterfaces: listOf(card.supportedInterfaces).map((entry) => ({
      url: entry.url,
      protocolBinding: entry.protocolBinding,
      ...textPresent("tenant", entry.tenant),
      protocolVersion: entry.protocolVersion,
    })),
    ...(provider === undefined
      ? {}
      : { provider: { organization: provider.organization, url: provider.url } }),
    ...present("documentationUrl", card.documentationUrl),
    ...present("iconUrl", card.iconUrl),
    ...(capabilities === undefined
      ? {}
      : {
          capabilities: {
            ...present("streaming", capabilities.streaming),
            ...present("pushNotifications", capabilities.pushNotifications),
            ...present("extendedAgentCard", capabilities.extendedAgentCard),
            extensions: listOf(capabilities.extensions).map((extension) => ({
              uri: extension.uri,
              ...textPresent("description", extension.description),
              required: extension.required,
              ...metadataOf(extension.params),
            })),
          },
        }),
    securitySchemes: { ...card.securitySchemes },
    securityRequirements: [...listOf(card.securityRequirements)],
    defaultInputModes: [...listOf(card.defaultInputModes)],
    defaultOutputModes: [...listOf(card.defaultOutputModes)],
    skills: listOf(card.skills).map(skillOf),
  };
}
