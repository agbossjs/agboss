---
section: Fixed
issue: 1361
---

**A change of a pause's deadline keeps both guards of I3** (#1361, #1356; the transition is `timeoutChange` since #1307, which lets a deadline move earlier or be set or taken away): the change is refused unless its deadline is after the moment of the write, and the one it is made over (`previousExpiresAt`, absent: none) is the stored one; a change that leaves `previousExpiresAt` out at runtime is no longer given one. No migration.
