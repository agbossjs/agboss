import type { Class } from "../../components/injection.js";
import { throwIfViolated } from "../../graph/rule-error.js";
import { TEST_PSEUDONYM_KEY } from "../../pii/application-key.js";
import { modelDetectionOf } from "../../pii/detectors/model.js";
import { isCustomPolicy } from "../../pii/pii-policy.decorator.js";
import { conflictViolations, piiPolicyMetaOf, policyViolations } from "../../pii/policy-checks.js";
import { PiiPolicySet } from "../../pii/policy-set.js";
import { DetectionMode, runtimePolicyOf, type RuntimePiiPolicy } from "../../pii/runtime-policy.js";
import { revealedText } from "../../pii/tokens.js";
import { TestSetupError } from "../errors.js";
import { piiPolicyKeyOf } from "../scripted-gateway.js";
import { UnitSite } from "./unit-site.js";
import { unitChatSettings } from "./unit-models.js";
import type { UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/**
 * `@PiiPolicy` classes on their own (#262 S55, S62, #120): `mask` is what a model would read,
 * `reveal` what its answer becomes before any DTO is validated.
 */
export interface PiiRunner extends UnitClock {
  /**
   * The text as the policies mask it at the model boundary — `{ output: "Write to <email:7f3a91>",
   * spend }`; a block rule rejects with `PiiRefusedError`. The tokens are kept, as an execution's
   * `piiTokens` are.
   */
  mask(text: string): Promise<UnitRun<string>>;
  /** Every token this runner made, replaced by its value; an unknown one stays as it is. */
  reveal(text: string): string;
}

function runtimePoliciesOf(site: UnitSite, policies: readonly Class[]): RuntimePiiPolicy[] {
  return policies.map((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined) throw new TestSetupError(`testPii: ${cls.name} is not a @PiiPolicy`);
    const model = isCustomPolicy(meta) ? undefined : meta.detectWithModel;
    const detection = (name: string, id: string) => {
      const settings = unitChatSettings(id);
      const user = { kind: "pii-policy", policy: name } as const;
      return modelDetectionOf(name, {
        model: site.gateway.chatModel({ user, settings }),
        settings,
      });
    };
    return runtimePolicyOf({
      meta,
      instance: site.instanceOf(cls),
      key: TEST_PSEUDONYM_KEY,
      ...(model === undefined ? {} : { detectWithModel: detection(meta.name, model) }),
    });
  });
}

/**
 * The policies as an element that lists them applies them (#120): their own rules checked first
 * (`[name.kind-suffix]` — a name ends with `-pii-policy` —, `[pii.conflicting-rules]`, …, a
 * `GraphRuleError` with all of them), each created by the runner's container (a project detector's
 * `deps`, `overrides`, the `environment`), tokens made with the fixed test key; a `detectWithModel`
 * policy's model answers from `model` (`replyWith('{"found":[…]}')`, one turn per detection).
 */
export function testPii(policies: readonly Class[], options: UnitModelOptions = {}): PiiRunner {
  const [first] = policies;
  if (first === undefined) throw new TestSetupError("testPii([]): name the policies to apply");
  throwIfViolated([...policyViolations(policies), ...conflictViolations("testPii", policies)]);
  const site = new UnitSite(options);
  for (const cls of policies) {
    const meta = piiPolicyMetaOf(cls);
    if (meta !== undefined && !isCustomPolicy(meta) && meta.detectWithModel !== undefined)
      site.scriptModel(piiPolicyKeyOf(meta.name), cls.name, options.model);
  }
  const set = new PiiPolicySet(runtimePoliciesOf(site, policies), TEST_PSEUDONYM_KEY);
  const tokens: Record<string, string> = {};
  const frame = { component: first, caller: "pii:test" };
  return {
    clock: site.clock,
    mask: (text) =>
      site.run(frame, async ({ spent }) => {
        const { masked, usage } = await set.mask(text, tokens, DetectionMode.WithModel);
        spent.push(...usage);
        const refused = await set.refusalError(masked.blocked, usage);
        if (refused !== undefined) throw refused;
        Object.assign(tokens, masked.tokens);
        return masked.text;
      }),
    reveal: (text) => revealedText(text, tokens).text,
  };
}
