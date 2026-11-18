---
section: Fixed
issue: 1332
---

**A model's read of a file by url takes a fetch slot** (#1332, found by the acceptance of #1256): the
download in `file-bytes.ts` passed no slots, so it had no concurrency cap and no tenant or owner
share. It now takes a slot of the application's slots, under the keys an A2A listener uses (the
tenant's, and the thread owner's inside it); over them it fails as a download failure whose cause is
`a2a.file-fetch-busy`, and the slot goes back when the read ends or is aborted. A listener with no
`maxConcurrentFileFetches*` option shares those slots with the models' reads; one with an option
keeps slots of its own.
