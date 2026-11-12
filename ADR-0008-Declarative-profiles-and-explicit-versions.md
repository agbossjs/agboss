# ADR-0008 — Declarative profiles over a typed base, explicit versions

- **Status:** Accepted
- **Issue:** #78

## Context

Turn versions were opaque hashes; comparing two configurations meant remembering what changed and
replaying tasks through git commits.

## Decision

- The TypeScript config stays the base and gets an explicit `version`.
- Variants are declarative YAML profiles (Spring-Boot-like) listing only differences, validated by a
  schema generated from zod (deep-partial, strict) and re-validated after the merge.
- Turns store the declared version plus a hash of the resolved config; a snapshot per version;
  a warning when the content changes without a version bump (OpenAPI-like).
- Golden sets are YAML in the repo; `compare` reports mean score, pairwise wins, cost, latency and
  the config diff, on the eval budget.

## Consequences

- Two config forms: TypeScript for the base, YAML for profiles.
- A fully declarative bundle (agents and prompts in YAML) was considered and left for later.
