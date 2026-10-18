import { A2AAgent } from "../../../src/a2a/a2a-decorator.js";
import {
  PiiAction,
  PiiPolicy,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../../src/pii/index.js";
import { A2AClient } from "../../../src/a2a/a2a-client.js";
import { Channel, Guardrail, Rag } from "../../../src/components/decorators.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import type { ChannelSenderAsk } from "../../../src/channels/channel-sender.js";
import { Action } from "../../../src/flow/decorators/action.js";
import {
  Judge,
  type JudgeHandler,
  type JudgeInput,
  type JudgeVerdict,
} from "../../../src/components/judge-decorators.js";
import { Injectable, InjectionToken, Tool, type ToolHandler } from "../../../src/index.js";
import { Text } from "../../../src/dto/index.js";
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

@Tool({ name: "reveal", description: "Reveals", input: Query, output: Revealed, deps: [Vault] })
export class RevealTool implements ToolHandler<Query, Revealed> {
  constructor(private readonly vault: Vault) {}
  run(): Promise<Revealed> {
    return Promise.resolve({ text: this.vault.secret });
  }
}

@Guardrail({ name: "audit", deps: [Vault] })
export class AuditGuardrail implements Guardrail {
  constructor(private readonly vault: Vault) {}
  beforeAgentAnswer(): Promise<void> {
    seen.push(`guardrail:${this.vault.secret}`);
    return Promise.resolve();
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

@Judge({ name: "strict", model: "test/strict", deps: [Vault] })
export class StrictJudge implements JudgeHandler {
  constructor(private readonly vault: Vault) {}
  judge({ reply }: JudgeInput): Promise<JudgeVerdict> {
    return Promise.resolve({ passed: !reply.includes(this.vault.secret) });
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

@A2AAgent({ name: "remote", url: "http://remote.invalid", deps: [Vault] })
export class RemoteAgent extends A2AClient {
  constructor(readonly vault: Vault) {
    super();
  }
}
