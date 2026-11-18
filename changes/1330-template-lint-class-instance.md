---
section: Fixed
issue: 1330
---

**A project made by `agboss create` lints clean on typescript-eslint 8.73** (#1330): 8.73 added
`@typescript-eslint/no-unsafe-class-instance-assignment` to `strictTypeChecked`, which flags an object
literal where a DTO class is the parameter type (`execute(Start, { text })`, an `AppEnvironment`
literal): the documented call shape. The generated `eslint.config.js` turns the rule off, with the
reason in a comment.
