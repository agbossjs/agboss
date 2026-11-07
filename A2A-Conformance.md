# A2A conformance

The official A2A Technology Compatibility Kit ([a2aproject/a2a-tck](https://github.com/a2aproject/a2a-tck))
runs in CI against an AGBoss application (#811), as the job `a2a-tck` of `ci.yml`, and from a
checkout with `node scripts/a2a-tck.mjs [--dir <work dir>]` (needs `uv`; Python lives in the TCK's
own venv, `uv sync --frozen`).

## What runs

- **The TCK**: tag `1.0.0.alpha3`, commit `5daf0144b4a4adbdefb62180739b13c5bd7d8196`, Python 3.12,
  the JSON-RPC transport (the only binding AGBoss 0.1.1 serves). Pinned in
  `packages/agboss/tests/a2a-tck/tck-expected.json`.
- **The agent**: the conformance application `packages/agboss/tests/a2a-tck/tck.application.ts`,
  served by the real `a2aHttpListener` on `127.0.0.1` (`tck-serve.ts`). One exported skill — the TCK
  names none — whose paths end at a text finish, a DTO finish (a `data` artifact) or a pause its
  caller answers (`INPUT_REQUIRED`, a question role answered by the thread's owner), or fail with a
  coded error. The TCK tells its agent what to do by the messageId's prefix
  (`tck-complete-task-<session>`), which no workflow sees: a loopback adapter in front of the
  listener copies the prefix into a header, and the application's caller resolver gives it to the
  execution as a declared `ExecutionContext` field. The message itself is passed on as it came.
- **Two runs**: the TCK as published, then with `tck-defects.patch`, a fix of two TCK defects
  (below). Each run's requirements are checked against `tck-expected.json`: a requirement that
  fails and is not listed there, one listed that passes, or one that does not pass with no reason
  named fails the job.
- An offline check of the agent itself is `tests/a2a-tck/tck-sut.test.ts` (in `make check`).

## The results (5daf014)

| Run | Tests passed | failed | skipped | MUST requirements passing |
| --- | --- | --- | --- | --- |
| as published | 67 | 9 | 189 | 49 |
| with `tck-defects.patch` | 86 | 3 | 176 | 65 |

The tests skipped are the gRPC and HTTP+JSON variants (no such interface on the card), the push
notification methods (`capabilities.pushNotifications: false`), and requirements this TCK does not
automate (authorization, signed cards, binding equivalence, a client's version header). The job
prints every requirement that does not pass with its reason.

### TCK defects (`tck-defects.patch`)

- **One messageId for different messages.** `tck_id(prefix)` is one id per session, so several MUST
  requirements (CORE-EXECUTION-MODE-001/002, CORE-MULTI-001a/002a/003, and the MAY CORE-MULTI-001/002)
  send the same messageId with other content — and the setup task of others (CORE-CANCEL-001/002,
  CORE-GET-001, CORE-SEND-002, CORE-MULTI-005/006, STREAM-SUB-001/002/003, CORE-HIST-002/003/004)
  reuses one too, so the TCK skips them. A message's id is unique (a2a.proto `Message.message_id`):
  AGBoss deduplicates every messageId per tenant and owner and refuses one reused with other content
  (`-32602`) — the payment guarantee of [A2A → §2](A2A#2-serving--a2ahttplistenerapp-options), never
  relaxed for a test. The patch gives each call its own id.
- **CORE-SEND-003 declares no expected error.** Its text says a part of an unsupported media type
  MUST be `ContentTypeNotSupportedError`, and AGBoss answers `-32005` `ContentTypeNotSupportedError`
  (`ErrorInfo` reason `CONTENT_TYPE_NOT_SUPPORTED`); with no `expected_error`, the TCK takes any
  error as a failure. The patch declares it.

### What AGBoss 0.1.1 does not do (expected failures)

- **DM-ART-001 (MUST), its file variants**: the `tck-artifact-file` / `tck-artifact-file-url`
  scenarios need an artifact with a file part; AGBoss 0.1.1 has no file parts (an output is text or
  one `data` part). Its text and data variants pass.
- **DM-MSG-001 (MUST)**: the `tck-message-response` scenario needs a stateless `Message` answer;
  every AGBoss send is a durable task (one task = one execution). The spec allows either answer.
- **CORE-HIST-004 (MAY)**: no task history beyond the status message.

## Fixed by the TCK (#811)

- `GetExtendedAgentCard` is `-32004` `UnsupportedOperationError` (CORE-CAP-003; was `-32007`).
- The card has `Last-Modified` (CARD-CACHE-003).
