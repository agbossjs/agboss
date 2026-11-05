/**
 * #778: `@Application({ pseudonymKey })` under `testWith` — the application's key field gets the
 * test's fixed key when the test process does not set its variable; a test that sets it keeps its
 * own; production still refuses to start without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { TEST_PSEUDONYM_KEY } from "../../src/pii/application-key.js";
import { tokenOf } from "../../src/pii/tokens.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { execute } from "../helpers/flow.js";
import { requestText } from "./boundary.helpers.js";
import { KeyedAgent, KeyedStart } from "./keyed.fixture.js";
import { KeyedApplication } from "./fixtures/keyed/keyed.application.js";
import { PII_KEY_VARIABLE } from "./pii.fixture.js";

/** The variable of the fixture's `piiPseudonymKey: secret("PII_APP_KEY")`. */
const APP_KEY_VARIABLE = "PII_APP_KEY";
const MESSAGE = { text: "EMP-0042 at ann@acme.io", author: "zoe-7" };

const test = testWith(KeyedApplication);

describe("#778: the application's key under testWith, its variable not set", () => {
  beforeAll(() => {
    vi.stubEnv(APP_KEY_VARIABLE, undefined);
    vi.stubEnv(PII_KEY_VARIABLE, undefined);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test("runs and makes the application's tokens with the test key", async ({ app, mockLlm }) => {
    const agent = mockLlm(KeyedAgent).thenReturn(replyWith("ok"));

    await execute(app, KeyedStart, MESSAGE);

    const sent = requestText(agent.onlyRequest);
    expect(sent).toContain(tokenOf("employee-token", "EMP-0042", TEST_PSEUDONYM_KEY, {}));
    expect(sent).toContain(tokenOf("author", "zoe-7", TEST_PSEUDONYM_KEY, {}));
  });

  test("an empty variable counts as not set", async ({ app, mockLlm }) => {
    vi.stubEnv(APP_KEY_VARIABLE, "");
    const agent = mockLlm(KeyedAgent).thenReturn(replyWith("ok"));

    await execute(app, KeyedStart, MESSAGE);

    expect(requestText(agent.onlyRequest)).toContain(
      tokenOf("employee-token", "EMP-0042", TEST_PSEUDONYM_KEY, {}),
    );
  });
});

describe("#778: the application's key under testWith, its variable set by the test", () => {
  const OWN_APP_KEY = "the-test's-own-app-key";
  beforeAll(() => {
    vi.stubEnv(APP_KEY_VARIABLE, OWN_APP_KEY);
    vi.stubEnv(PII_KEY_VARIABLE, undefined);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test("keeps the test's own value", async ({ app, mockLlm }) => {
    const agent = mockLlm(KeyedAgent).thenReturn(replyWith("ok"));

    await execute(app, KeyedStart, MESSAGE);

    const sent = requestText(agent.onlyRequest);
    expect(sent).toContain(tokenOf("employee-token", "EMP-0042", OWN_APP_KEY, {}));
    expect(sent).not.toContain(tokenOf("employee-token", "EMP-0042", TEST_PSEUDONYM_KEY, {}));
  });
});

describe("#778: production without the application's key", () => {
  it("createApp refuses to start, naming the field and its variable", async () => {
    const failure = await createApp(KeyedApplication, {
      processEnv: { [PII_KEY_VARIABLE]: "own-policy-key" },
      gateway: createScriptedGateway(new ScriptBook()),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      `${APP_KEY_VARIABLE} is not set (PiiEnvironment.piiPseudonymKey, dev)`,
    );
  });
});
