# Security policy

## Reporting a vulnerability

Report a vulnerability privately by email to **security@agboss.dev** — never in a public issue, pull
request or discussion. If email is not an option, use GitHub's private reporting instead
([Security → Report a vulnerability](https://github.com/agbossjs/agboss/security/advisories/new)).

Please include:

- the affected package (`@agboss/core` or `@agboss/cli`) and its version, or the commit of `main`;
- what an attacker can do and under which conditions (the component involved — a tool, a channel, a
  PII policy, a guardrail, an MCP server, an infrastructure implementation, …);
- the steps to reproduce: ideally a minimal application or test (`testWith(App)` from
  `@agboss/core/testing`) that shows the problem with scripted models, no real keys;
- the environment it was seen in (Node version, operating system, which built-in or SQLite
  implementations are listed);
- whether the issue is already public anywhere, and how you would like to be credited.

Do not send real secrets, model provider keys or personal data — mask them.

## What to expect

- **Acknowledgement** within 3 business days.
- **A first assessment** — whether it is accepted as a vulnerability, its severity and the planned
  fix — within 10 business days.
- **Updates** at least every 2 weeks until it is resolved.
- **The fix** in a patch release of the supported line, announced in a GitHub Security Advisory and in
  [`CHANGELOG.md`](CHANGELOG.md), crediting the reporter unless asked otherwise. Please keep the
  report private until the fix is released; we coordinate the disclosure date with you, normally
  within 90 days of the report.

## Supported versions

AGBoss is in pre-1.0 development: the API changes between minor releases (see
[`CHANGELOG.md`](CHANGELOG.md)). Security fixes go to the latest release and to `main`.

| Version                   | Supported                       |
| ------------------------- | ------------------------------- |
| `main`                    | yes                             |
| the latest `0.x` release  | yes                             |
| earlier `0.x` releases    | no — upgrade to the latest      |
| `0.0.1` (npm placeholder) | no — it holds no framework code |

Once 1.0 ships, the latest minor release of each supported major line receives fixes; the
maintenance lines are listed here.

## Scope

In scope: the `@agboss/core` and `@agboss/cli` packages, the project templates `agboss create` writes, and
the examples in this repository as far as they show how the framework is meant to be used.

Out of scope: vulnerabilities in a model provider, an MCP server or another third-party service
itself, and prompt-injection results that the documented guardrails, PII policies and tool approvals
are configured to stop but were not enabled in the reported application — report those as ordinary
issues if the documentation could prevent them better.
