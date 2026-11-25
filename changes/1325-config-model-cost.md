---
section: Changed
issue: 1325
---

**A call that cannot be accounted is `ConfigError.ModelCost`** (#1325b): a model call with no reported cost and no price, a fallback with neither, and tokens that price at no amount throw `ConfigError.ModelCost` (`config.model-cost`, facts `model` and `field`) instead of the broad `ConfigError.Component`; the router's and the reranker's recording of a paid call that cannot be priced, and the partial-usage record of a failed call, catch exactly it. A tool's invalid cost stays a `ConfigError.Component`.
