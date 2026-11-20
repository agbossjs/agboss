---
section: Fixed
issue: 1361
---

**An extension of a pause's deadline keeps both guards of I3** (#1361, #1356): #1360 had dropped two checks of `extendChange`. A pause with no deadline gets none again even when the change leaves `previousExpiresAt` out at runtime (it was given one), and an extension is refused unless it is after the moment as well as after the deadline it moves from. No migration.
