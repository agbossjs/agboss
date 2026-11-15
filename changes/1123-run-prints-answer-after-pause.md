---
section: Fixed
issue: 1123
---

**`agboss run` prints the answer after a pause** (#1123 acceptance): the run resumed after an approval
or a question now streams to the terminal like the first leg, and a text that was retracted before the
pause (the sentence before a tool call) no longer stops the CLI from printing the result — the answer is
printed from the result whenever the text that streamed and was not retracted is not it. A line piped at
once (`echo y | agboss run …`) is kept for the approval prompt instead of being lost while the agent works.
