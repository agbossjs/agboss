---
section: Breaking
issue: 1301
---

**PII rules are written on the kind: three verbs, `PiiKind` / `PiiGroup` descriptors, no `pii(…)`**
(#1301, part of #498): a declarative `@PiiPolicy` repeated `pii` / `PiiKind` / `PiiAction` on every
line, wrapped a refusal in a one-key object, and `replaceWithKind()` said "kind" where a `sensitive`
field's placeholder is the field's name. There are three actions now — `mask()` / `mask(part)`,
`tokenize()`, `block(refusal?)` — on `PiiAction` and on every kind and group, which are descriptors
(`.id`, `toJSON()`, compared by identity, written by their id) instead of enum strings. Token labels
and placeholders keep each kind's id, so a token made before is the same token now. A rule that
names a kind or a group a second time in one policy is `[pii.duplicate-target]` at assembly. A
value a detection model files under a kind of no id is masked as `<pii>` with the warning
`pii.model-unknown-kind`, and one under a kind the policy names no rule for is masked under its
label: what a policy cannot place is never let through. No alias is kept.

Migration:

- `pii(PiiKind.Email, PiiAction.replaceWithKind())` → `PiiKind.Email.mask()`;
  `pii(PiiKind.CardNumber, PiiAction.replacePart({ keepLast: 4 }))` →
  `PiiKind.CardNumber.mask({ keepLast: 4 })`; `pii(PiiKind.Phone, PiiAction.replaceWithToken())` →
  `PiiKind.Phone.tokenize()`; `pii(PiiKind.UsSsn, PiiAction.blockWithRefusal({ refusal: "…" }))` →
  `PiiKind.UsSsn.block("…")`, `blockWithRefusal()` → `block()`; the same on `PiiGroup.*`.
- `sensitive:` and a project detector's `action:` take `PiiAction.mask()`, `PiiAction.mask(part)`
  or `PiiAction.tokenize()`.
- Removed: `pii`, `PiiRefusalOptions`, `PiiAction.replaceWithKind` / `replacePart` /
  `replaceWithToken` / `blockWithRefusal`, `ReplaceWithKindAction`, `ReplacePartAction`,
  `ReplaceWithTokenAction`, `BlockWithRefusalAction`. Renamed: `PiiActionKind.ReplaceWithKind` /
  `ReplacePart` / `ReplaceWithToken` / `BlockWithRefusal` → `Mask` (`"mask"`) / `MaskPart`
  (`"mask-part"`) / `Tokenize` (`"tokenize"`) / `Block` (`"block"`). Added: `MaskAction`,
  `MaskPartAction`, `TokenizeAction`, `BlockAction`, `PiiKind.fromId(id)`, `PiiTargetDescriptor`,
  `PiiKindDescriptor`, `PiiGroupDescriptor`, `PiiRuleCode` (the PII part of `RuleCode`).
- `PiiKind` is no string: a `refusal(kind: PiiKind)` writes `kind.id` (`String(kind)` and a
  template literal also give the id); a comparison with `"email"` is `kind === PiiKind.Email` or
  `kind.id === "email"`; `PiiKind.Email` is a value, not a type.
- `configHash` and the cached masks change once with the new action names (the policies are
  hashed by them); the tokens do not.
