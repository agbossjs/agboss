import type { Class } from "../../../components/injection.js";
import { modelProviderOf } from "../../../models/model-provider.decorator.js";
import { PromptLoader } from "../../../components/prompt-render.js";
import { arbiterOf, hasArbiterModel, isDeclarativeArbiter } from "../../decorators/arbiter.js";
import { arbiterClassesOf, type ModelArbiterUse, type RuntimeLaunch } from "./runtime-launch.js";

/**
 * Every model arbiter's `prompt`, read at assembly like any prompt (#1347): a `./` file relative to
 * the file that declared the arbiter, `inline(…)`, or a list of them, with the workflow's variables.
 * A problem is the loader's, reported with the agent prompts' at once. By the arbiter's name.
 */
export async function arbiterPromptsOf(
  launches: readonly RuntimeLaunch[],
  loader: PromptLoader,
): Promise<ReadonlyMap<string, string>> {
  const loaded = await Promise.all(
    arbiterClassesOf(launches).flatMap((arbiter) => {
      const declaration = arbiterOf(arbiter);
      if (declaration === undefined || !isDeclarativeArbiter(declaration.options)) return [];
      const { name, prompt } = declaration.options;
      return [
        loader
          .load({ label: `@Arbiter "${name}"`, options: { prompt }, source: declaration.source })
          .then((text): [string, string] => [name, text]),
      ];
    }),
  );
  return new Map(loaded);
}

/**
 * One model arbiter's use outside a workflow assembly (a unit test): a declarative one's prompt read
 * as at assembly, with no workflow variables; a code arbiter that injects `ArbiterModel` has its
 * own model and provider and no prompt; any other has none.
 */
export async function unitArbiterUsesOf(arbiter: Class): Promise<readonly ModelArbiterUse[]> {
  const declaration = arbiterOf(arbiter);
  if (declaration === undefined || !hasArbiterModel(declaration.options)) return [];
  const { options } = declaration;
  const provider =
    options.modelProvider === undefined
      ? {}
      : { modelProvider: modelProviderOf(options.modelProvider).name };
  if (!isDeclarativeArbiter(options))
    return [{ name: options.name, model: options.model ?? "", prompt: "", ...provider }];
  const loader = new PromptLoader();
  const text = await loader.load({
    label: `@Arbiter "${options.name}"`,
    options: { prompt: options.prompt },
    source: declaration.source,
  });
  loader.throwIfAny();
  return [{ name: options.name, model: options.model ?? "", prompt: text, ...provider }];
}
