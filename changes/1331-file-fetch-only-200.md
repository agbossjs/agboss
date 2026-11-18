---
section: Fixed
issue: 1331
---

**An A2A file by url is a file only when its origin answers `200`** (#1331, found by the acceptance of
#1244): any 2xx was taken as the whole file, so a `206` (we never send `Range`: its body is part of
one) gave a partial file and a `204` an empty one. Any other status, a 2xx too, is now the refused
fetch `a2a.file-fetch-failed`, with none of the response in its message; a `200` whose body ends
short of its `Content-Length` was already one.
