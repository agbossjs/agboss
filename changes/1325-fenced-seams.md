---
section: Added
issue: 1325
---

**`pauseFencedOf(key)` and `stopFencedOf(key)` in `@agboss/core/stores`**, next to `cancelFencedOf`: a store outside the core refuses a write fenced by its tree's `Immediate` pause or `Immediate` stop with them, and the core takes the refusal as the pause or the stop it is (never as a cancel). They return `AGBossError`; the internal error classes stay out of the public API, and a store needs no `@agboss/core/internal` import for its fences.
