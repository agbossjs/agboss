---
section: Breaking
issue: 1324
---

**No LangGraph type is public: `SqliteCheckpointSaver`, `LatestByStepCheckpointSaver` and `hasLatestByStep` moved to `@agboss/core/internal`** (#1324): the root and `@agboss/core/stores` no longer export them, so `agboss-stores.api.md` imports nothing from `@langchain/langgraph`. `@agboss/core/stores` keeps the pure functions `stepOf`, `NO_STEP`, `compareCodePoints`, `newestFirstOrder`, `childThreadOf`, `isChildThreadOf` and `childThreadRangeOf`. An application takes its checkpoints from the `@DatabaseStorage` driver (`SqliteDriver`, the store packages' drivers), not from a listed saver class.
