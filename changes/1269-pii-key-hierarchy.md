---
section: Security
issue: 1269
---

**One PII key hierarchy: every digest under a key of its own purpose, none an oracle** (#1269): the PII
key (`piiKeyField`, a policy's `pseudonymKey`, or an execution's own) is now a root that no digest is
made with directly. Each use derives its own key by HKDF-SHA256 under a label of its own — tokens
(`agboss/pii/pseudonym/v2`), a policy set's hash, a cached redacted copy's key, a loop's masked texts —
and each digest is an HMAC under it. A policy set's hash (part of a cached file transcription's key) was
a plain SHA-256 over the policies, the key and the sensitive values; a loop's masked texts were kept by
a plain SHA-256 of the text; a cached redaction was keyed by an HMAC under the execution's own key,
which its checkpoint kept beside it. Now every digest kept in a checkpoint is under the application's
(or the instance's) key, which no store holds, and the execution's own key roots its tokens only. The
application's own `FileRedactor` and `FileTranscriber` are part of `configHash` by class name, so a run
paused under one is not resumed blindly under another (`IncompatibleResumeError`); workflows of an
application without one keep their hash. **Tokens change once:** one value gets another token than
under 0.1.0 (see Upgrading to 0.1.1); a 0.1.0 token map is still revealed as it is.
