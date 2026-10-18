import type { Class } from "../components/injection.js";
import type { NameOf } from "../flow/generated-types.js";

/** What `createApp(W)` / `testWith(W)` give for a `@Workflow` class `W`: a type naming the fix. */
export interface WorkflowIsNotAnApplication {
  readonly __error: "a @Workflow is not an application — list it in an @Application({ workflows }) and pass the application";
}

/**
 * The class `createApp` and `testWith` take (#261): an `@Application`. A `@Workflow` class does not
 * compile — the generated `.agboss/types.d.ts` brands it with its name (`…-workflow`) — and fails
 * at run time naming the fix where the types are not generated.
 */
export type ApplicationClass<TApplication extends Class> = TApplication &
  ([NameOf<InstanceType<TApplication>>] extends [never]
    ? unknown
    : NameOf<InstanceType<TApplication>> extends `${string}-workflow`
      ? WorkflowIsNotAnApplication
      : unknown);
