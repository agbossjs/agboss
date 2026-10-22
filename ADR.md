# Architecture Decision Records

One page per significant, hard-to-reverse decision: `ADR-NNNN-Title`, from
[the template](ADR-Template). Written when the implementing PR is merged, linked from its issue.

| ADR                                                                                                                        | Status   |
| -------------------------------------------------------------------------------------------------------------------------- | -------- |
| [0001 — Jev as default router](ADR-0001-Jev-default-router)                                                                | Accepted |
| [0002 — Template ships only the Agent Core + CLI](ADR-0002-Core-and-CLI-only)                                              | Accepted |
| [0003 — Typed tools and MCP facades](ADR-0003-Typed-tools-and-MCP-facades)                                                 | Accepted |
| [0004 — Pause in projects, seam in the core](ADR-0004-Pause-seam)                                                          | Accepted |
| [0005 — Tracing with self-hosted Langfuse](ADR-0005-Tracing-with-self-hosted-Langfuse)                                     | Accepted |
| [0006 — Quality-gated reasoning attempts](ADR-0006-Quality-gated-reasoning-attempts)                                       | Superseded by 0015 |
| [0007 — Conversation memory as a FIFO queue of summaries](ADR-0007-Conversation-memory-as-a-FIFO-queue-of-summaries)       | Accepted |
| [0008 — Declarative profiles over a typed base, explicit versions](ADR-0008-Declarative-profiles-and-explicit-versions)    | Accepted |
| [0009 — Angular-style components with constructor injection](ADR-0009-Angular-style-components-with-constructor-injection) | Accepted |
| [0010 — RAG as a contract, implementations by the developer](ADR-0010-RAG-as-a-contract)                                   | Accepted |
| [0011 — GraphCompose: framework package and examples apart](ADR-0011-graphInject-framework-package-and-examples-apart)    | Accepted |
| [0012 — Rename to GraphCompose](ADR-0012-Rename-to-GraphCompose)                                                           | Accepted |
| [0013 — DTO classes instead of zod](ADR-0013-DTO-classes-instead-of-zod)                                                    | Accepted |
| [0014 — The workflow file is the graph (transitions), the hub router removed](ADR-0014-Graph-as-transitions)               | Superseded by 0019 |
| [0015 — Own agent loop instead of `createAgent`](ADR-0015-Own-agent-loop)                                                   | Accepted |
| [0016 — Model providers as components, settings checked against models](ADR-0016-Model-providers)                         | Accepted |
| [0017 — Fork-Join and Parallel Execution](ADR-0017-Fork-Join-and-Parallel-Execution) | Superseded by 0019 (parallel forms: #273) |
| [0018 — Rename to AGBoss](ADR-0018-Rename-to-AGBoss) | Accepted |
| [0019 — The flow as paths, with a path scope and generated types](ADR-0019-Flow-as-paths-with-path-scope) | Accepted (its rollback bullet replaced by 0020) |
| [0020 — Declared compensation: explicit where a path can say it, automatic where none can](ADR-0020-Declared-compensation) | Accepted |
| [0021 — Project skills shipped with the framework](ADR-0021-Project-skills-shipped-with-the-framework) | Accepted |
