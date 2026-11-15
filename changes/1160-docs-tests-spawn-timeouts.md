---
section: Fixed
issue: 1160
---

**The docs tests that spawn scripts no longer fail under machine load** (#1160): the release
checklist, changelog and wiki-overlay tests run bash, git and node processes, and their cases and
hooks now carry timeouts sized to those spawns instead of vitest's 5 s default, which a loaded
machine exceeded (`#1084 AC1` ran 5191 ms). The global timeout is unchanged.
