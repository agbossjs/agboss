---
section: Fixed
issue: 1250
---

**`SqliteFtsConnector` keeps the real error when SQLite already ended its transaction** (#1250):
opening the index file rolled back unconditionally, so an error after which SQLite had ended the
transaction itself (a full disk, an I/O error) was replaced by "cannot rollback - no transaction is
active". The rollback now runs only while the transaction is open. No migration.
