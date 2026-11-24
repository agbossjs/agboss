---
section: Added
issue: 1328
---

**`testModule`, `testAgent`, `mockRag`, `mockA2A`, `mcpServer`, `answerPause`, `replyToPause`** (#1328, part b): `await testModule({ components })` assembles the workflows and services you list on one container, clock and set of stores (`runAgent`, `runAction`, `runTool`, `runRouter`, `get`, the mocks, `close`); `await testAgent(Agent, { workflow })` is one agent as a function of its input message. `mockRag(Rag)` and `mockA2A(Agent)` script the one call of a knowledge base or an A2A peer that leaves the process; `mcpServer(Endpoint, options)` serves the test's app over MCP, as `a2aServer` does over A2A. `answerPause(Target, decision, { actor? })` and `replyToPause(Target, reply, { actor? })` answer the pause the test's last `execute` left — the eval builders' own calls. `app.action(Action).run(input)` joins the app's slices. `testUnit` of a router or a judge whose generated types are missing is `MissingGeneratedTypes`, not a runner.
