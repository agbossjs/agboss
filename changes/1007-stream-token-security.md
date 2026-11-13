---
section: Security
issue: 1007
---

**PII pseudonym tokens no longer reach the user's stream** (#1007): a token (`<email:9cf08e>`) is an
HMAC of the value under the application's key, meant for models, logs and traces — `onStream` and
the A2A artifact showed it to end users and let them compare it across answers. The stream carries
the revealed value, or a made-up token's kind, never a token.
