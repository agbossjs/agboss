import type { Class } from "../components/injection.js";
import { targetsOfUses, type ChannelUse } from "./discovery.js";
import type { PauseTargetDeclaration } from "./pause-targets.js";

/** The pause targets the uses name (each once), with what they recorded. */
export const targetsOf = (
  uses: readonly ChannelUse[],
): readonly [Class, PauseTargetDeclaration][] =>
  targetsOfUses(uses).map(
    ({ target, declaration }) => [target, declaration] as [Class, PauseTargetDeclaration],
  );
