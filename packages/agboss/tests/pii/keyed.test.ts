/** #120: the application's PII key — one token per value on every instance, a policy's own key wins. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { applicationOf } from "../../src/application/assemble.js";
import { tokenOf } from "../../src/pii/tokens.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "./boundary.helpers.js";
import {
  KeyedAgent,
  KeyedStart,
  MisnamedKeyApplication,
  UnkeyedApplication,
} from "./keyed.fixture.js";
import { KeyedApplication } from "./fixtures/keyed/keyed.application.js";
import { PII_KEY_VARIABLE } from "./pii.fixture.js";

const APP_KEY = "shared-app-key";
const OWN_KEY = "own-policy-key";
const MESSAGE = { text: "EMP-0042 at ann@acme.io, +1 555 123 4567", author: "zoe-7" };

beforeAll(() => {
  vi.stubEnv("PII_APP_KEY", APP_KEY);
  vi.stubEnv(PII_KEY_VARIABLE, OWN_KEY);
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const instances = testWith(KeyedApplication, { instances: 2 });

describe("#120: the application's pseudonymKey", () => {
  instances(
    "two instances give one value one token — a project's detector, a sensitive field",
    async ({ apps, mockLlm }) => {
      const agent = mockLlm(KeyedAgent).thenReturnAlways(replyWith("ok"));
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances");

      await execute(first, KeyedStart, MESSAGE);
      await execute(second, KeyedStart, MESSAGE);

      const [one, two] = agent.requests.map(requestText);
      const employee = tokenOf("employee-token", "EMP-0042", APP_KEY, {});
      const author = tokenOf("author", "zoe-7", APP_KEY, {});
      expect(one).toContain(employee);
      expect(two).toContain(employee);
      expect(one).toContain(author);
      expect(two).toContain(author);
      expect(one).toContain(tokenOf("phone", "+1 555 123 4567", APP_KEY, {}));
    },
  );

  instances("a policy's own key wins over the application's", async ({ apps, mockLlm }) => {
    const agent = mockLlm(KeyedAgent).thenReturn(replyWith("ok"));
    const [first] = apps;
    if (first === undefined) throw new Error("an instance");

    await execute(first, KeyedStart, MESSAGE);

    const sent = requestText(agent.onlyRequest);
    expect(sent).toContain(tokenOf("email", "ann@acme.io", OWN_KEY, {}));
    expect(sent).not.toContain(tokenOf("email", "ann@acme.io", APP_KEY, {}));
  });
});

describe("#120: a missing application key", () => {
  it("fails the start when a policy needs it, naming the field to set", async () => {
    const failure = await createApp(UnkeyedApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'unkeyed-application: employee-token-pii-policy, app-key-pii-policy make tokens with the application\'s PII key — set @Application({ pseudonymKey: "piiPseudonymKey" }) with piiPseudonymKey: secret("…") in the environment',
    );
  });

  it("a key field the contract does not declare fails assembly", async () => {
    const failure = await applicationOf(MisnamedKeyApplication).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GraphRuleError);
    expect((failure as GraphRuleError).violations).toContainEqual(
      expect.objectContaining({
        code: "environment.missing-field",
        message: "@Application pseudonymKey needs piiKey: Secret in EmptyEnvironment",
      }),
    );
  });
});
