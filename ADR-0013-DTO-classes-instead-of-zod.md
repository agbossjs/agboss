# ADR-0013 — DTO classes instead of zod

- **Status:** Accepted (supersedes the zod part of [ADR-0003](ADR-0003-Typed-tools-and-MCP-facades))
- **Issue:** #118 (spikes #113, #115)

## Decision

- Data shapes — tool inputs and outputs, server tools — are **classes with one field decorator per
  field** from `@agboss/core/dto` (`@Text`, `@Integer`, `@DateTime`, `@ListOf(Job)`, …). The decorator
  says what the model reads (`prompt`) and what is checked; the class is the type. zod is used **only
  inside** the framework (`schemaOf`), and the model sees `jsonSchemaOf` (`io: "input"`, no `$schema`,
  fields in declaration order).
- **Compile time** is exactly: decorator ↔ field type, `optional` ↔ `?`, `@OneOf` values ≡ the union, the
  element type of `@ListOf` / `@Nested`, a public non-static field. Formats, limits, integer vs decimal
  and cross-field rules are **runtime** validation. An undecorated field or a DTO with behaviour is a
  **startup** error (`dto.undecorated-field`, `dto.not-plain-data`).
- DTOs are **plain data** (no methods, no private fields), so object literals fit them; the price is
  structural typing — two DTOs with the same fields are interchangeable to the compiler.
- Metadata goes through `context.metadata`; `agboss` sets `Symbol.metadata` when imported, because
  `tsc` output has none on Node 22–26. A test runs a `tsc`-compiled DTO against `dist`.
- 16 standard DTOs ship with the framework ([Standard DTOs](Standard-DTOs)); names come in pairs from one
  noun (`FileRead` → `FileContent`).

## Consequences

- One way to declare data in a workflow; job-scout, `agboss g tool` and `agboss g mcp` use DTOs.
- Configuration (`search.config.ts`) and the run input keep zod until #121 / #117.
- A server tool that returns only text declares `TextAnswer` (one field `text`) instead of `z.string()`.
