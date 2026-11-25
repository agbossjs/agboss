---
section: Breaking
issue: 1301
---

**A PII policy has a `secret` and a `previousSecret`; the application's PII key is the storage's
`piiSecret`; a token with no key fails the start (`[pii.secret-required]`)** (#1301, part of #498):
`pseudonymKey` is `secret?: SecretRef` on a `@PiiPolicy`, with `previousSecret?: SecretRef |
OptionalSecretRef` for rotation, and `@DatabaseStorage` takes `previousPiiSecret` beside `piiSecret`.
A value a thread already holds a token for under the previous key keeps that token, a new value gets
one under the new key, and every old token still reveals; `PiiPolicySet.previousFingerprint` (and the
redaction and mask-cache digests) hash under the old roots, so a cached transcription made before the
rotation is found. A `tokenize()` rule or action without a `secret`, or a `sensitive:
PiiAction.tokenize()` field, with no `piiSecret` fails the start naming the policy or `Dto.field`;
No storage supplies a key; `testWith` has a fixed test key, refused under `NODE_ENV=production`. `WorkflowStartTextDto.author` is `mask()`.
`detectWithModel` is `model`, beside `modelProvider`. The `Logger` a component injects is masked by
the application's PII log mask, as the framework's own log is. The image redactor paints a region
with a target it was not asked for and warns (`files.redactor-unknown-target`) instead of refusing
the file; a region that cannot be painted still refuses.

Removed: `pseudonymKey`, `detectWithModel`, the `[application.pii-instance-key]` warning (a key made up
by the instance no longer makes tokens), the refusal of an unknown redaction target. Added: `secret`,
`previousSecret`, `model` on `@PiiPolicy`; `previousPiiSecret` on `@DatabaseStorage`;
`[pii.secret-required]`; `TEST_PREVIOUS_PSEUDONYM_KEY`; the log code `files.redactor-unknown-target`.
See [Upgrading to 0.1.1](Upgrading-to-0.1.1#pii-keys--a-policys-secret-the-storages-piisecret-rotation-1301).
