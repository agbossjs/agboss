# Guards

Safety checks before and after the agents. A guard is a **router with two options** — `flag` /
`pass` — plus a threshold on P(flag). Same machinery as routers: Jev by default, any guard can set its
own model, every call is billed.

```mermaid
flowchart LR
  S([START]) --> IG[input guards]
  IG -- tripped --> E([END])
  IG -- pass --> R[router] --> A[agent] --> R
  R --> F[finalize] --> OG[output guards] --> E
```

## Configure

<!-- snippet-context
import { Agent, Workflow, WorkflowFinish, WorkflowSettings, WorkflowStart, start, type WorkflowDefinition } from "agboss";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "agboss/dto";
@WorkflowStart({ name: "support-workflow-start", description: "A message", input: WorkflowStartTextDto })
export class ChatWorkflowStart {}
@Agent({ name: "support-agent", description: "Answers", prompt: "Answer the message.", model: "moonshotai/kimi-k2.6" })
export class SupportAgent {}
@WorkflowFinish({ name: "support-workflow-finish", description: "The answer", output: WorkflowFinishTextDto })
export class ChatWorkflowFinish {}
-->

```ts
@Workflow({
  name: "support-workflow",
  version: "1.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(SupportAgent)
      .toFinish(ChatWorkflowFinish),
  ],
  defaults: {
    models: { temperature: 0 },
    guardrail: { model: "typesafe/jev-1.13" }, // the guards' model unless one sets its own (#261)
    history: { limit: 5 },
  },
  guards: {
    input: { prompt_injection: { threshold: 0.7, refusal: "I can't help with that request." } },
    output: {
      pii: { threshold: 0.7, refusal: "The answer contained personal data and was withheld." },
    },
  },
})
export class Support implements WorkflowDefinition {
  settings() {
    return WorkflowSettings.builder()
      .build();
  }
}
```

The question each guard asks and what `flag` / `pass` mean are the framework's texts
(`prompt_injection`, `pii`); a guard name without texts stops startup (`MissingGuardPromptError`).

## Behaviour

| Situation                                     | Result                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| input guard trips                             | no router or agent call; answer = its refusal; `stop: stopped by guard: <name>`; Tern status `guarded` |
| output guard trips                            | the agents' answer is replaced by the refusal; same stop reason and status                             |
| P(flag) < threshold                           | content passes                                                                                         |
| a guard cannot routeTo (API error, bad output) | **fails closed**: `GuardFailedError`, its spend still in the ledger                                    |

Guards of one side run in order; the first that trips stops. Cost appears as
`router:guard:<name>` in the report. Guard texts are part of the prompt version of a Tern.

## Guardrails — your own checks around tools and answers

Code checks are `@Guardrail` classes (created by the container with their `deps`) attached to the
workflow (`@Workflow({ guardrails })`), an agent or a tool (`guardrails`, `overrideGuardrails`,
`disableGuardrails`). Their hooks run at the agent loop's boundary ([Agents](Agents)):
`beforeToolCall` (may override the arguments), `afterToolCall`, `onChannelDecision`,
`beforeAgentAnswer`; a hook that throws stops the move.

<!-- snippet-context
type GuardrailContext = Parameters<NonNullable<Guardrail["beforeAgentAnswer"]>>[0];
-->

```ts
import { Guardrail } from "agboss";

@Guardrail({ name: "no-card-numbers" })
export class NoCardNumbers implements Guardrail {
  beforeAgentAnswer(ctx: GuardrailContext): Promise<void> {
    if (/\b\d{4}( ?\d{4}){3}\b/.test(ctx.replyWith ?? ""))
      return Promise.reject(new Error(`${ctx.agent} tried to answer with a card number`));
    return Promise.resolve();
  }
}
```

## PII policies

A `@PiiPolicy` says which personal data the models never see as is, and what happens to it
(#120). Two forms, one decorator:

- **declarative** — `@PiiPolicy({ name, description, rules: [pii(Kind | Group, Action)],
  detectWithModel?, pseudonymKey? })`, `name` ending with `-pii-policy`; without a
  `pseudonymKey` its tokens use the application's;
- **a project's own detector** (S59, S61) — `@PiiPolicy({ name, action, deps? })` +
  `implements PiiPolicyHandler`: `findMatches(text)` returns `PiiMatch { start, end }` ranges (or a
  promise of them), and the framework applies `action` (a masking one) to each. Its label is its
  name without `-pii-policy` (`<employee-id:…>`).

<!-- snippet-context
import {
  Injectable,
  PiiAction,
  PiiGroup,
  PiiKind,
  PiiPolicy,
  pii,
  secret,
  type PiiMatch,
  type PiiPolicyHandler,
  type PiiRefusal,
} from "agboss";
-->

```ts
@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides contact details from models",
  rules: [
    pii(PiiGroup.Contact, PiiAction.replaceWithKind()),
    pii(PiiKind.Email, PiiAction.replacePart({ keepDomain: true })), // a kind rule beats its group
    pii(PiiKind.Phone, PiiAction.replaceWithToken()),
    pii(PiiKind.CardNumber, PiiAction.blockWithRefusal()), // the text: refusal(kind)
  ],
  pseudonymKey: secret("PII_PSEUDONYM_KEY"), // optional: absent → the application's key
})
export class ContactPiiPolicy implements PiiRefusal {
  refusal(kind: PiiKind): string {
    return `Please do not send a ${kind}.`;
  }
}

@Injectable()
export class EmployeeDirectory {
  locateEmployeeIds(text: string): readonly PiiMatch[] {
    const start = text.indexOf("EMP-");
    return start < 0 ? [] : [{ start, end: start + 8 }];
  }
}

@PiiPolicy({
  name: "employee-id-pii-policy",
  action: PiiAction.replaceWithToken(),
  deps: [EmployeeDirectory],
})
export class EmployeeIdPiiPolicy implements PiiPolicyHandler {
  constructor(private readonly employeeDirectory: EmployeeDirectory) {}

  findMatches(text: string): readonly PiiMatch[] {
    return this.employeeDirectory.locateEmployeeIds(text);
  }
}
```

### Kinds and detection

Only what the rules name is detected. Inside one policy a kind rule beats a group rule;
overlapping ranges → the longest wins (a tie: the more specific format).

| Group (`PiiGroup`) | Kinds (`PiiKind`)                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `Contact`          | `Email`, `Phone`, `StreetAddress`\*, `PostalCode`                                        |
| `Identity`         | `PersonName`\*, `DateOfBirth`\*                                                         |
| `Government`       | `UsSsn`, `UsItin`, `UkNino`, `IsraeliId`, `PassportNumber`\*, `DriverLicense`\*, `NationalId`\* |
| `Financial`        | `CardNumber`, `Iban`, `SwiftBic`, `BankAccount`\*, `UsEin`                              |
| `Network`          | `IpAddress`, `MacAddress`, `GeoCoordinates`                                               |
| `Credentials`      | `ApiKey`, `Jwt`, `PrivateKey`, `Password`                                                 |

Formats are validated — Luhn (cards), IBAN mod 97, the Israeli ID check digit, the SSN issuance
rules (no 000 / 666 / 9xx area, no 00 group, no 0000 serial), ITIN groups, NINO prefixes, EIN
prefixes, IPv4 octets, coordinate ranges, SWIFT country codes. The kinds marked \* have no format:
in free text only `detectWithModel` (a chat model; its calls are `pii:<policy>` in the spend, every
model checked against the providers' `serves`) finds them, and a rule naming one without it is
`[pii.kind-needs-model]`. A detection answer that is not the JSON asked for fails closed
(`PiiDetectionFailedError`, `pii.detection-failed`): nothing goes to the model unmasked.

### Actions

| Action                                             | The model reads           | Reversible |
| -------------------------------------------------- | ------------------------- | ---------- |
| `PiiAction.replaceWithKind()`                      | `<israeli-id>`            | no         |
| `PiiAction.replacePart({ keepFirst?, keepLast?, keepDomain? })` | `•••• 4242`, `d•••@acme.com` | no |
| `PiiAction.replacePart({ pattern })`               | every match as `••••`     | no         |
| `PiiAction.replaceWithToken()`                     | `<email:7f3a91>`          | yes        |
| `PiiAction.blockWithRefusal({ refusal })` / `()`   | — refused                 | —          |

`replacePart` takes either what to keep or what to replace — both does not compile. A token is the
first hex digits of the HMAC-SHA256 of the normalised value with `pseudonymKey`, so one value is
one token everywhere (longer when a prefix is taken in the execution). The key comes from one of two
places:

- the policy's own `pseudonymKey`;
- the application's key, `@Application({ pseudonymKey: "piiPseudonymKey" })` — a `Secret` field of
  the environment ([Environments → The PII key](Environments#the-pii-key)). It is shared by every
  instance, so tokens match across machines. Sensitive fields and project detectors always use it. `blockWithRefusal()` without
a text takes `refusal(kind)` of the class (`implements PiiRefusal`, its services through `deps`);
none → `[pii.missing-refusal]`, a method no rule uses → `[pii.unused-refusal]`. A block rule in an
incoming message or in an answer fails the execution with `PiiRefusedError` (`pii.refused`,
`kind`, `refusal` — the text to send instead); in tool arguments or a tool result it rejects only
that call (the model reads `Tool error: the call was refused: …`).

### Levels

`piiPolicies` on `@Application` → `@Workflow` → `@Agent` / `@Router`: the lists add up;
`excludePiiPolicies` on an agent or a router removes an inherited one for its own model and tools
(excluding one that is not inherited is `[pii.exclude-not-inherited]`). After adding up, two
policies with different actions for one kind are `[pii.conflicting-rules]`, naming the kind, the
actions and the policies — no "strictest wins". A child workflow gets its own workflow's lists over
the application's, never its parent's. Logs, traces, events and `result.record` are always masked
by the application's and the workflow's lists ([Observability](Observability)).

### The model boundary (S38)

Masking and revealing happen only at the model boundary. Into a model: the instructions, the
thread's memory and summaries, the input message, the moves and the tool results — the whole
request, every call (a text is searched once per agent visit; its masked form is kept in the
loop's `piiMasked`). Out of it: the move's text and every tool-call and answer-tool argument are
revealed right after parsing, **before** any DTO is validated — a tool gets `alice@example.com`,
an `@Email` field validates the address; a token no map knows is an invalid answer (the model reads
why, S9 retries). In the tool task a block rule in the arguments rejects the call before `run`, and
the result is closed right after (its `sensitive` fields through their actions, then its text). The
scope, `outdatedValues`, the checkpoint and every step's code (actions, finishes, code routers,
arbiters, channels) hold real values; encrypting a store is that store's concern. A router's model
reads its input masked too.

Only `replaceWithToken` values are stored: the execution's `piiTokens` channel (token → value, in
the checkpoint) — branches merge it by key, and it survives a pause, a resume and a recovery.

### Sensitive fields

`sensitive: PiiAction.…` on a DTO field applies one masking action to a field without a format of
its own (`WorkflowStartTextDto.author` is `replaceWithToken()`); on the identity fields of a
`TenantContext` / `ExecutionContext` subclass the values are masked wherever they appear in what a
model reads ([Context and authorization](Context-And-Authorization)). A channel shows a token or a
kind field as `<field-name>`.

### Testing

Under `testWith` a `pseudonymKey` (a policy's or the application's) whose variable is unset gets a
fixed test key, and
`mockLlm(ContactPiiPolicy)` scripts a policy's model detection like any model.
