# The AGBoss skills extension — `https://agboss.dev/a2a/skills/v1`

A data-only extension of A2A v1.0 (spec §4.6): the JSON Schemas of an AGBoss agent's skills — what
A2A's `AgentSkill` has no field for — and the skill a message runs. (#808 the server, #809 the
client; to be mirrored at agboss.dev.)

## Declaration — the Agent Card

```json
{
  "uri": "https://agboss.dev/a2a/skills/v1",
  "required": false,
  "params": {
    "skills": {
      "<skill id>": {
        "input": { "type": "object", "properties": {} },
        "schemaHash": "<64 hex>",
        "outputs": { "<finish name>": { "type": "object" } }
      }
    }
  }
}
```

- A skill's id is the exported `@WorkflowStart`'s name; `input` its input DTO's JSON Schema (`null`
  for a text start), `outputs` one schema per finish it can end at, `schemaHash` the input's hash —
  what `agboss check --federation` compares.
- A client with DTOs compares them with these before anything is sent (`[a2a.schema-mismatch]`).

## In a message — `message.metadata[uri].skill`

The skill the message runs: optional when the agent serves one, else required
(`-32602 a2a.skill-required`; an unknown one `a2a.unknown-skill`). A completed task's artifact names
its finish in `artifact.metadata[uri].finish`.

See [A2A](A2A) for the framework's side.
