---
section: Fixed
issue: 1178
---

**The fault suite waits for the closed notice of a tree that ended failed or cancelled** (#1178): the
run's settle before its facts are read looked only for `end` events, so a tree ending `failed` (a
cancel) was waited for not at all and its `closed` notice, still on its way, was judged lost — red on
a correct store by timing, green on a broken one. It now treats `end` and `failed` of a root alike and
waits, up to the scenario's bound, for every pause of an ended tree to be told. No migration.
