import type { ModelCapabilities } from "./capabilities.js";
import type { ModelProblem } from "./problems.js";
import { ModelKind } from "./model-kind.js";
import type { InputNeed, ModelUse } from "./uses.js";

const DECISION_IMAGES = new Set(["image/png", "image/jpeg", "image/webp"]);

const problemOf = (
  use: ModelUse,
  need: InputNeed,
  where: string,
  supported: string,
): ModelProblem => ({
  code: "model.unsupported-input",
  key: use.key,
  value: `${need.mediaType} (${need.view})`,
  model: where,
  supported,
});

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
  return (use.needs ?? []).flatMap((need): ModelProblem[] => {
    if (!inputs.includes(need.kind))
      return [
        problemOf(use, need, where, `takes ${inputs.join(", ") || "nothing"}, not ${need.kind}`),
      ];
    // a decision model's image is a png, jpeg or webp (`Decision.image`): a gif is no image to it
    if (
      use.purpose === ModelKind.Decisions &&
      need.kind === "image" &&
      !DECISION_IMAGES.has(need.mediaType)
    )
      return [
        problemOf(use, need, where, "takes png, jpeg and webp images, not " + need.mediaType),
      ];
    return [];
  });
}
