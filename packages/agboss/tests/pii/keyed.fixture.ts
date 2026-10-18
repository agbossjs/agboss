/** The application's PII key (#120): one token per value on every instance. */
import {
  Agent,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
  secret,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { EmployeeDirectory, PII_KEY_VARIABLE } from "./pii.fixture.js";

/** Employee ids by token: a project's detector, with the application's key. */
@PiiPolicy({
  name: "employee-token-pii-policy",
  action: PiiAction.replaceWithToken(),
  deps: [EmployeeDirectory],
})
export class EmployeeTokenPiiPolicy implements PiiPolicyHandler {
  constructor(private readonly directory: EmployeeDirectory) {}

  findMatches(text: string): readonly PiiMatch[] {
    return this.directory.ids.flatMap((id) => {
      const start = text.indexOf(id);
      return start < 0 ? [] : [{ start, end: start + id.length }];
    });
  }
}

/** Emails by token with its own key: the policy's key wins over the application's. */
@PiiPolicy({
  name: "own-key-pii-policy",
  description: "Emails, with a key of its own",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithToken())],
  pseudonymKey: secret(PII_KEY_VARIABLE),
})
export class OwnKeyPiiPolicy {}

/** Phones by token without a key: the application's. */
@PiiPolicy({
  name: "app-key-pii-policy",
  description: "Phones, with the application's key",
  rules: [pii(PiiKind.Phone, PiiAction.replaceWithToken())],
})
export class AppKeyPiiPolicy {}

@Agent({
  name: "keyed-agent",
  description: "Answers",
  prompt: "Answer.",
  model: "test/keyed",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
})
export class KeyedAgent {}

@WorkflowStart({
  name: "keyed-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class KeyedStart {}

@WorkflowFinish({
  name: "keyed-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class KeyedFinish {}

@Workflow({
  name: "keyed-workflow",
  version: "1.0.0",
  flow: [start(KeyedStart).returns(WorkflowStartTextDto).toAgent(KeyedAgent).toFinish(KeyedFinish)],
  defaults: { models: { temperature: 0 } },
  piiPolicies: [EmployeeTokenPiiPolicy, OwnKeyPiiPolicy, AppKeyPiiPolicy],
  providers: [EmployeeDirectory],
})
export class KeyedWorkflow {}

/** The same workflow in an application that sets no key: its project detector needs one. */
@Application({
  name: "unkeyed-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [KeyedWorkflow],
  budgets: TEST_BUDGETS,
})
export class UnkeyedApplication {}

/** A key field the contract does not declare. */
@Application({
  name: "misnamed-key-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  pseudonymKey: "piiKey",
  workflows: [KeyedWorkflow],
  budgets: TEST_BUDGETS,
})
export class MisnamedKeyApplication {}
