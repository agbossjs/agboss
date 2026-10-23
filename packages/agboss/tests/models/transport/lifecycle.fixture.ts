import {
  Injectable,
  type OnDestroy,
  type OnInit,
  type OnStart,
  type OnStop,
} from "../../../src/index.js";
import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { bedrockApplicationOn } from "./bedrock-apps.fixture.js";
import { answer } from "./bedrock-provider.fixture.js";

/** #385 S4: what a transport provider's hooks and calls did, in order; `onStart` fails while `failures.starts` > 0. */
@Injectable()
export class LifecycleLog {
  readonly entries: string[] = [];
  readonly failures = { starts: 0 };
}

@ModelProvider({
  name: "lifecycle-model-provider",
  description: "A transport with lifecycle hooks",
  serves: [/^bedrock\//],
  timeout: seconds(30),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 100, window: minutes(1), openFor: seconds(1) },
  deps: [LifecycleLog],
})
export class LifecycleModelProvider
  implements ModelProviderHandler, OnInit, OnStart, OnStop, OnDestroy
{
  constructor(private readonly lifecycleLog: LifecycleLog) {}

  onInit(): void {
    this.lifecycleLog.entries.push("onInit");
  }

  async onStart(): Promise<void> {
    this.lifecycleLog.entries.push("onStart");
    await Promise.resolve();
    if (this.lifecycleLog.failures.starts === 0) return;
    this.lifecycleLog.failures.starts -= 1;
    throw new Error("the SDK session could not be opened");
  }

  onStop(): void {
    this.lifecycleLog.entries.push("onStop");
  }

  onDestroy(): void {
    this.lifecycleLog.entries.push("onDestroy");
  }

  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    this.lifecycleLog.entries.push(`complete ${request.model}`);
    return Promise.resolve(answer("ok", { cost: usd(0.01) }));
  }
}

export const LifecycleApplication = bedrockApplicationOn({
  name: "lifecycle-application",
  providers: [LifecycleModelProvider, LifecycleLog],
});
