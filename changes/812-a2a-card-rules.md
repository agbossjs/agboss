---
section: Added
issue: 812
---

**Assembly rules for what an A2A server says on its card** (#812): `[a2a.expose-description-required]`
refuses an `@A2AExpose` with a blank `description`; `[a2a.skill-tags]` (a warning) names an exported
skill with no `tags` (its card says the application's name); `[a2a.unpriced-foreign-peer]` (a
warning) names an `@A2AAgent` without `target.application` and without `price`, whose spend is
invisible to the budgets. Warnings are errors under `agboss check --strict`: give each skill
`skills: { "<start name>": { tags } }` and each foreign agent a `price`.
