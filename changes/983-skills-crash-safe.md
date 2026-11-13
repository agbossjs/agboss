---
section: Fixed
issue: 983
---

**The project skills sync is crash-safe, contained and serialised** (#983 acceptance): a crash
between the two renames of the folder swap no longer loses the project's own files — the next run
puts the newest complete leftover (`.agents/.agboss-skills-*`, `-old`) back before planning, and a
leftover that holds files of the project's own which the live folder lacks is never deleted (kept,
with a `[skills.unmanaged-file]` naming it). The move of a 0.1.x folder no longer writes through a
symlinked subfolder of `.agents/skills/agboss/`: it is refused with `[skills.outside-project]` and
nothing is written (a dangling or foreign link at a file's place is never written through). Syncs of
one project take a lock (`.agents/.agboss-skills-lock`, stale after 10 s), so a `dev` pass beside
`npm install` no longer prints a false `[skills.sync-failed]` or `[skills.link-failed]`; a link
another run just made is `current`. The READMEs say a fresh clone prints `linked`, and that
`agboss create` writes `.gitattributes` too.
