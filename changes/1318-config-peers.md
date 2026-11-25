---
section: Breaking
issue: 1318
---

**The `a2aEndpoints`, `a2aAgents` and `mcpServers` shelves of a profile** (#1318, part 1318c).

- `a2aEndpoints: { "<name>": { ttl: { tasks, messages } } }`: how long an `@A2AEndpoint` keeps its tasks and its direct
  messages' replies. The assembly rule (`[a2a.ttl-invalid]`), the card, the listener and the retention sweep all read the
  profile's values.
- `a2aAgents: { "<name>": { url, allowedOrigins, timeout, costPerCall } }`: an `@A2AAgent`'s address, call bound and
  price. The rules (`[a2a.cost-per-call-invalid]`), the unpriced-foreign warning, `describe`, the federation snapshot
  and the client itself (`A2AClient.contract`, its address) read the profile's values inside an application.
- `mcpServers: { "<name>": { timeout, costPerCall, maxConcurrentCalls, url, command, args } }`: an `@McpServer`'s bounds,
  price and connection, as the assembly hands them to the connection. A setting the server's transport has not
  (`url` on a stdio server, `command` / `args` on an HTTP one) is a `ProfileError`.
- Every shelf is read through the one carrier of the components' options (`ComponentOptions.a2aEndpointMetaOf`,
  `a2aAgentMetaOf`, `mcpServerMetaOf`); a declared class and its record are never changed. A name the application lacks
  is a `ProfileError`.
- `A2AClient.contract` is now a getter (it is the profile's contract inside an application).
