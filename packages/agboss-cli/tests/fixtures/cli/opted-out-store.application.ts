import {
  Application,
  Clock,
  EmptyEnvironment,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  InMemoryFencedEffectRepository,
  Injectable,
  LeaseCheck,
} from "../../../../agboss/src/index.js";
import { IN_MEMORY_DATABASE } from "../../../../agboss/src/infrastructure/in-memory-database.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { TestWorkflow } from "../../../../agboss/tests/fixtures/test-workflow/test.workflow.js";

/** A fenced-effect store on no declared backend that opts out of the atomic lease check. */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] })
export class OptedOutEffects extends InMemoryFencedEffectRepository {
  static override readonly backend: string | undefined = undefined;
  static override readonly leaseCheck: LeaseCheck = LeaseCheck.WithoutDoubleChargeProtection;
}

/**
 * `agboss check` fixture (#526 AC1, acceptance): the opt-out is not checked against the leases —
 * a warning, `[application.lease-check-not-atomic]`, an error under `--strict`.
 */
@Application({
  name: "opted-out-store-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TestWorkflow],
  providers: [OptedOutEffects],
  budgets: TEST_BUDGETS,
})
export class OptedOutStoreApplication {}

// the workflow agboss check types (.agboss/types.d.ts)
export { TestWorkflow };
