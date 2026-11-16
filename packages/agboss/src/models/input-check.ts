import type { ModelCapabilities } from "./capabilities.js";
import type { ModelProblem } from "./problems.js";
import type { ModelUse } from "./uses.js";

/**
 * Input kinds against what a model says it takes (#899 §4): every kind a strict use reads must be in
 * the model's `inputs`, else `[model.unsupported-input]` (the setting, the model, the media type and the
 * view). A model that says nothing of its inputs is not checked.
 */
export function inputProblems(
  use: ModelUse,
  capabilities: ModelCapabilities,
  where = use.model,
): readonly ModelProblem[] {
  const { inputs } = capabilities;
  if (inputs === undefined || use.isNeedStrict !== true) return [];
  return (use.needs ?? [])
    .filter((need) => !inputs.includes(need.kind))
    .map((need) => ({
      code: "model.unsupported-input",
      key: use.key,
      value: `${need.mediaType} (${need.view})`,
      model: where,
      supported: `takes ${inputs.join(", ") || "nothing"}, not ${need.kind}`,
    }));
}
