---
section: Fixed
issue: 1007
---

**The stream shows the revealed value, not the PII token** (#1007): an agent with a
`replaceWithToken` policy streamed `Write to <email:9cf08e>.` while its output said `Write to
alice@example.com.`, and the internal pseudonym reached the user's screen. The stream now reveals
tokens with the run's map as the reply is revealed — also a token the model writes in pieces: a `<`
is held only while what follows can still be a token (`<kind:hex>`, at most about 96 characters), so
`if (a < b)` is not delayed. A token the run never minted (a hallucinated one) is shown as its kind
(`<email>`) and its attempt is refused as an invalid answer, as before. The stream is trimmed as the
reply is (no leading whitespace, trailing whitespace held), so the deltas of the steps that were
not discarded, joined, are exactly `output` (#1006).
