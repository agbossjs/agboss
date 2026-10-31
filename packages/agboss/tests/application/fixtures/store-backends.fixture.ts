/**
 * #526 — stores on every backend a test pairs: the core's own (in-memory, SQLite) and stores of
 * other backends ("postgres", a second PostgreSQL database "postgres:billing", "redis"), stores that
 * declare none or an empty one, and stores that opt out of the atomic lease check. They are the
 * in-memory stores underneath: only their declarations are read at assembly.
 */
import { Application } from "../../../src/application/application.js";
import type { Class, Provider } from "../../../src/components/injection.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import {
  ApplicationContext,
  Clock,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  Injectable,
  LeaseCheck,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
} from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { SqliteTestEnvironment } from "../../infrastructure/sqlite/fixtures/environments/app.environment.js";
import { MortalExecutionLeaseRepository } from "../../infrastructure/fixtures/recovery.workflow.js";
import { ReleaseWorkflow } from "../../app/fixtures/fence.workflow.js";

const LEASE_DEPS = { deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] } as const;
const EFFECT_DEPS = {
  deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository],
} as const;
const CALL_DEPS = { deps: [Clock, IN_MEMORY_DATABASE, ExecutionLeaseRepository] } as const;

@Injectable(LEASE_DEPS)
export class PostgresLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = "postgres";
}

@Injectable(LEASE_DEPS)
export class BillingLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = "postgres:billing";
}

@Injectable(LEASE_DEPS)
export class RedisLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = "redis";
}

@Injectable(LEASE_DEPS)
export class UndeclaredLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = undefined;
}

@Injectable(LEASE_DEPS)
export class EmptyLeases extends InMemoryExecutionLeaseRepository {
  static override readonly backend: string | undefined = "";
}

@Injectable(EFFECT_DEPS)
export class PostgresEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "postgres";
}

@Injectable(EFFECT_DEPS)
export class BillingEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "postgres:billing";
}

@Injectable(EFFECT_DEPS)
export class RedisEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "redis";
}

@Injectable(EFFECT_DEPS)
export class UndeclaredEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = undefined;
}

@Injectable(EFFECT_DEPS)
export class EmptyEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "";
}

/** The opt-out with no backend at all: a store that checks a lease kept elsewhere. */
@Injectable(EFFECT_DEPS)
export class UncheckedEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = undefined;
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}

/** The opt-out on a declared backend: not compared with the lease store's either. */
@Injectable(EFFECT_DEPS)
export class UncheckedRedisEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = "redis";
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}

@Injectable(CALL_DEPS)
export class PostgresCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = "postgres";
}

@Injectable(CALL_DEPS)
export class BillingCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = "postgres:billing";
}

@Injectable(CALL_DEPS)
export class RedisCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = "redis";
}

@Injectable(CALL_DEPS)
export class UndeclaredCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = undefined;
}

@Injectable(CALL_DEPS)
export class EmptyCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = "";
}

@Injectable(CALL_DEPS)
export class UncheckedCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = undefined;
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}

@Injectable(CALL_DEPS)
export class UncheckedRedisCalls extends InMemoryOutboundCallRepository {
  static override readonly backend: string | undefined = "redis";
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}

/** A lease store of a pairing: listed, or none (the in-memory default). */
export interface LeaseChoice {
  readonly name: string;
  readonly listed?: Class;
  /** What the application's lease store declares. */
  readonly backend: string | undefined;
}

/** A fencing store of a pairing. */
export interface FencingChoice {
  readonly store: Class;
  readonly backend: string | undefined;
  readonly isOptedOut: boolean;
}

export const LEASES: readonly LeaseChoice[] = [
  { name: "none listed (InMemoryExecutionLeaseRepository)", backend: "in-memory" },
  {
    name: "InMemoryExecutionLeaseRepository",
    listed: InMemoryExecutionLeaseRepository,
    backend: "in-memory",
  },
  {
    name: "a subclass of the in-memory store",
    listed: MortalExecutionLeaseRepository,
    backend: "in-memory",
  },
  {
    name: "SqliteExecutionLeaseRepository",
    listed: SqliteExecutionLeaseRepository,
    backend: "sqlite",
  },
  { name: "PostgresLeases", listed: PostgresLeases, backend: "postgres" },
  { name: "BillingLeases", listed: BillingLeases, backend: "postgres:billing" },
  { name: "RedisLeases", listed: RedisLeases, backend: "redis" },
  { name: "UndeclaredLeases", listed: UndeclaredLeases, backend: undefined },
  { name: "EmptyLeases", listed: EmptyLeases, backend: undefined },
];

const choice = (store: Class, backend: string | undefined, isOptedOut = false): FencingChoice => ({
  store,
  backend,
  isOptedOut,
});

export const EFFECT_STORES: readonly FencingChoice[] = [
  choice(InMemoryFencedEffectRepository, "in-memory"),
  choice(SqliteFencedEffectRepository, "sqlite"),
  choice(PostgresEffects, "postgres"),
  choice(BillingEffects, "postgres:billing"),
  choice(RedisEffects, "redis"),
  choice(UndeclaredEffects, undefined),
  choice(EmptyEffects, undefined),
  choice(UncheckedEffects, undefined, true),
  choice(UncheckedRedisEffects, "redis", true),
];

export const CALL_STORES: readonly FencingChoice[] = [
  choice(InMemoryOutboundCallRepository, "in-memory"),
  choice(SqliteOutboundCallRepository, "sqlite"),
  choice(PostgresCalls, "postgres"),
  choice(BillingCalls, "postgres:billing"),
  choice(RedisCalls, "redis"),
  choice(UndeclaredCalls, undefined),
  choice(EmptyCalls, undefined),
  choice(UncheckedCalls, undefined, true),
  choice(UncheckedRedisCalls, "redis", true),
];

/** An application listing `providers` (no `SqliteConnection`: it is created, #526 AC8). */
export function storesApplication(providers: readonly Provider[]): Class {
  @Application({
    name: "stores-application",
    version: "1.0.0",
    environment: SqliteTestEnvironment,
    workflows: [ReleaseWorkflow],
    budgets: TEST_BUDGETS,
    providers,
  })
  class StoresApplication {}
  return StoresApplication;
}
