---
section: Fixed
issue: 1105
---

**The skills sync lock and links, round two** (#1105, #1106, #1107, #1108, follow-up of #1013): a lock dated more than a minute in the future (a clock set back, a folder from a host that runs ahead) is taken over like an old one instead of blocking every `agboss check` until the clock catches up; a dead holder's lock is cleared whole, so a stray `.DS_Store` in it no longer delays the take-over by 10 minutes. An own link in `.agents/skills/agboss/` is judged by where the kernel leads it (each link followed before the next `..`), so `docs/symlinked/../x` is no longer kept when it leaves the project. A 0.1.x `.claude/skills/agboss/` behind a linked `.claude` or `.claude/skills` gets a warning that says so (`[skills.link-blocked]`), only the move is refused and `.agents/skills/agboss/` is still synced. No migration.
