import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (#180)
    expect: { requireAssertions: true },
    // the contract fixtures run only inside tests/testing/contracts (#481: a nested vitest)
    exclude: ["tests/smoke/**", "node_modules/**", "tests/fixtures/contracts/**"],
    // the workflow matchers (agboss/testing/setup in a project)
    setupFiles: ["./src/testing/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // thin entry points, exercised by `npm run studio` and `npm run schema`
      exclude: ["src/studio.ts", "src/graph/studio-graph.ts", "src/config/write-profile-schema.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        // DTOs (#118): the data every tool and server exchanges
        "src/dto/**": { lines: 90, branches: 90, functions: 90, statements: 90 },
        // the model-call seam (#135): every model call goes through it
        "src/llm/gateway.ts": { lines: 90, branches: 90, functions: 90, statements: 90 },
        // model providers (#151): every model call's provider, retries, breaker, wire form
        "src/models/**": { lines: 90, branches: 90, functions: 90, statements: 90 },
        // the app and the testing toolkit (#135)
        "src/app/**": { lines: 90, branches: 90, functions: 90, statements: 90 },
        "src/testing/**": { lines: 90, branches: 90, functions: 90, statements: 90 },
        // the agent's own loop (#150)
        "src/graph/agent-loop/**": { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
