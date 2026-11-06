/**
 * The AGBoss extensions of A2A v1.0 (#805, design §3), by their URIs (spec §4.6: an extension is
 * named by its URI; a breaking change takes a new one).
 */

/**
 * The skills extension (data-only): the card's skills' input and output JSON Schemas in its
 * `params`, and the skill a message runs in `message.metadata[A2A_SKILLS_EXTENSION].skill`
 * (optional when the agent serves one skill).
 */
export const A2A_SKILLS_EXTENSION = "https://agboss.dev/a2a/skills/v1";

/**
 * The mesh extension (profile): where a failed task's stable code is sent, in
 * `status.message.metadata[A2A_MESH_EXTENSION].code`.
 */
export const A2A_MESH_EXTENSION = "https://agboss.dev/a2a/mesh/v1";
