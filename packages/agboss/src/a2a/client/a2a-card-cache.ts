import type { Client } from "@a2a-js/sdk/client";
import type { Clock } from "../../infrastructure/clock.js";
import { minutes, type Milliseconds } from "../../units/index.js";
import { checkCard, fetchCard, type CheckedCard } from "./a2a-card.js";
import type { A2AClientContract } from "./a2a-client-options.js";
import type { OriginPolicy } from "./a2a-origins.js";
import { A2A_MESH_EXTENSION } from "../a2a-extension-uris.js";
import type { ExtensionEcho } from "./a2a-echo.js";
import { sdkClientOf, wireFetchOf } from "./a2a-transport.js";

/**
 * A client's agent card and SDK client (#809): fetched on first use through the client's one
 * fetch (its origins, its headers), checked against its contract, kept `ttl` on the app's clock —
 * a cache, not state of an execution.
 */

/** A card fetched for a client, with its SDK client and when it was fetched. */
export interface Wire {
  readonly checked: CheckedCard;
  readonly client: Client;
  readonly fetchedAt: number;
  /**
   * Whether the answer to the send of `messageId` echoed the mesh extension (#810) — taken once;
   * `undefined` when no send of it asked for the mesh.
   */
  readonly meshEchoOf: (messageId: string) => boolean | undefined;
}

/** What the cache is built with. */
export interface CardCacheOptions {
  readonly url: string;
  readonly agent: string;
  readonly contract: A2AClientContract | undefined;
  readonly policy: OriginPolicy;
  readonly fetcher: typeof fetch;
  readonly headersOf: () => Promise<Record<string, string>>;
  /** How long a card is kept; default 5 minutes. */
  readonly ttl: Milliseconds | undefined;
}

const DEFAULT_CARD_TTL = minutes(5);

export class CardCache {
  readonly #options: CardCacheOptions;
  readonly #fetch: typeof fetch;
  readonly #ttl: Milliseconds;
  readonly #wires = new Map<string, Wire>();
  /** The mesh echo of each send that asked for it, by messageId, until its accept takes it. */
  readonly #echoes = new Map<string, boolean>();

  constructor(options: CardCacheOptions) {
    this.#options = options;
    const echo = {
      uri: A2A_MESH_EXTENSION,
      onEcho: ({ messageId, isEchoed }: ExtensionEcho) => {
        this.#echoes.set(messageId, isEchoed);
      },
    };
    this.#fetch = wireFetchOf(options.fetcher, options.headersOf, options.policy, echo);
    this.#ttl = options.ttl ?? DEFAULT_CARD_TTL;
  }

  /** The card and its SDK client: the kept one while fresh, else fetched and checked again. */
  async wireOf(clock: Pick<Clock, "now">, signal: AbortSignal | undefined): Promise<Wire> {
    const { url, agent, contract, policy } = this.#options;
    const now = clock.now().getTime();
    const kept = this.#wires.get(url);
    if (kept !== undefined && now - kept.fetchedAt < this.#ttl) return kept;
    const checked = await fetchCard(url, this.#fetch, policy, signal);
    checkCard(checked.card, {
      agent,
      skill: contract?.skill,
      input: contract?.input,
      output: contract?.output,
    });
    const client = await sdkClientOf(checked.card, this.#fetch);
    const meshEchoOf = (messageId: string): boolean | undefined => {
      const echoed = this.#echoes.get(messageId);
      this.#echoes.delete(messageId);
      return echoed;
    };
    const wire = { checked, client, fetchedAt: now, meshEchoOf };
    this.#wires.set(url, wire);
    return wire;
  }
}
