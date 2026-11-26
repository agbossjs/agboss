import {
  Application,
  defineEnv,
  env,
  Observer,
  secret,
  type InferEnv,
} from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { TestWorkflow } from "../../../../agboss/tests/fixtures/test-workflow/test.workflow.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

/** The variables this application reads: a required value and a required secret, both behind `deps: [appEnv]`. */
export const needsEnv = defineEnv({
  url: env("ENV_NEEDS_URL"),
  key: secret("ENV_NEEDS_KEY"),
});

/** An observer the application's start creates; it reads the resolved values. */
@Observer({ deps: [needsEnv] })
export class NeedsObserver {
  constructor(readonly config: InferEnv<typeof needsEnv>) {}

  started = "";

  onExecutionStart(): void {
    this.started = this.config.url;
  }
}

/** `agboss check` fixture (#1324b, #266): types and assembly need no key; the unset variables are reported. */
@Application({
  modelProvider: TestModelProvider,
  name: "env-needs-application",
  version: "1.0.0",
  workflows: [TestWorkflow],
  observers: [NeedsObserver],
  budgets: TEST_BUDGETS,
})
export class EnvNeedsApplication {}

// the workflow agboss check types (.agboss/types.d.ts)
export { TestWorkflow };
