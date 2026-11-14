---
section: Fixed
issue: 1075
---

**The skills sync lock heals itself in more cases** (#1075, #1076, #1077, follow-up of #1013): a lock whose owner file is empty, garbage or unreadable, or whose folder holds only some other file, is taken over once it is older than 10 minutes (it used to block every `agboss check` for 12 s, forever); a `.agents/.agboss-skills-lock-new-*` left by a crash is removed when it is older than that. An own link in `.agents/skills/agboss/` is judged by real paths, so a link spelled through an alias such as `/tmp` is kept when it lands inside the project. In an interrupted 0.1.x move a legacy file is never lost when `.agents` has a link or folder at the same path (saved as `<name>.legacy`), and the own links of `.claude/skills/agboss/` are kept or named, never dropped silently. No migration.
