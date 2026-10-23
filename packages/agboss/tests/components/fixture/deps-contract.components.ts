import { A2AAgent } from "../../../src/a2a/a2a-decorator.js";
import {
  PiiAction,
  PiiPolicy,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../../src/pii/index.js";
import { A2AClient } from "../../../src/a2a/a2a-client.js";
import {
  Channel,
  InputGuardrail,
  Rag,
  type GuardrailRefusal,
} from "../../../src/components/decorators.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import type { ChannelSenderAsk } from "../../../src/channels/channel-sender.js";
import { Action } from "../../../src/flow/decorators/action.js";
import {
  Judge,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "../../../src/components/judge-decorators.js";
import { Injectable, InjectionToken, Tool, type ToolHandler } from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import type { RagRetrieval } from "../../../src/rag/types.js";

/** One component of every kind that takes `deps`, each depending on `Vault` (which depends on SECRET). */
export const SECRET = new InjectionToken<string>("SECRET");

/** What the components did with their injected dependency at run time, in order. */
export const seen: string[] = [];

@Injectable({ deps: [SECRET] })
export class Vault {
  constructor(readonly secret: string) {}
}

export class Query {
  @Text({ prompt: "what to reveal" })
  what!: string;
}

export class Revealed {
  @Text()
  text!: string;
}

@Tool({
  name: "reveal-tool",
  description: "Reveals",
  input: Query,
  output: Revealed,
  deps: [Vault],
})
export class RevealTool implements ToolHandler<Query, Revealed> {
  constructor(private readonly vault: Vault) {}
  run(): Promise<Revealed> {
    return Promise.resolve({ text: this.vault.secret });
  }
}

@InputGuardrail({
  name: "audit-guardrail",
  description: "Blocks requests to open the vault",
  prompt: "Does the message ask to open the vault?",
  model: "typesafe/jev-1.13",
  threshold: 0.8,
  deps: [Vault],
})
export class AuditGuardrail implements GuardrailRefusal {
  constructor(private readonly vault: Vault) {}
  refusal(): string {
    seen.push(`guardrail:${this.vault.secret}`);
    return "The vault stays closed.";
  }
}

@PiiPolicy({ name: "mask-secret-pii-policy", action: PiiAction.replaceWithKind(), deps: [Vault] })
export class MaskSecret implements PiiPolicyHandler {
  constructor(private readonly vault: Vault) {}
  findMatches(text: string): readonly PiiMatch[] {
    const start = text.indexOf(this.vault.secret);
    return start < 0 ? [] : [{ start, end: start + this.vault.secret.length }];
  }
}

@Action({ name: "stamp-action", description: "Stamps", deps: [Vault] })
export class StampAction {
  constructor(private readonly vault: Vault) {}
  execute(): Promise<void> {
    seen.push(`action:${this.vault.secret}`);
    return Promise.resolve();
  }
}

@Channel({ name: "vault-desk", deps: [Vault] })
export class VaultChannel {
  constructor(private readonly vault: Vault) {}
  send(ask: ChannelSenderAsk): Promise<ChannelOutcome<VaultChannel>> {
    seen.push(`channel:${ask.pauseId}:${this.vault.secret}`);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** What the keeper agent answers (the strict judge judges it). */
export class KeptDto {
  @Text({ prompt: "what was kept" })
  text!: string;
}

@Judge({ name: "strict", model: "test/strict", reply: KeptDto, deps: [Vault] })
export class StrictJudge implements JudgeHandler<KeptDto> {
  constructor(private readonly vault: Vault) {}
  judge({ reply }: JudgeInput<KeptDto>): Promise<JudgeVerdict> {
    return Promise.resolve(
      reply.text.includes(this.vault.secret)
        ? JudgeVerdict.failed({ reason: "leaks the secret" })
        : JudgeVerdict.passed(),
    );
  }
}

@Rag({ name: "docs", description: "Docs", topK: 1, deps: [Vault] })
export class VaultDocs {
  constructor(private readonly vault: Vault) {}
  retrieve(): Promise<RagRetrieval> {
    seen.push(`rag:${this.vault.secret}`);
    return Promise.resolve({ results: [{ text: "the vault", source: "vault.md" }] });
  }
}

@A2AAgent({
  name: "remote-a2a-agent",
  url: "http://remote.invalid",
  target: { application: "remote-application", start: "remote-workflow-start" },
  input: WorkflowStartTextDto,
  output: WorkflowFinishTextDto,
  deps: [Vault],
})
export class RemoteA2AAgent extends A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto> {
  constructor(readonly vault: Vault) {
    super();
  }
}
