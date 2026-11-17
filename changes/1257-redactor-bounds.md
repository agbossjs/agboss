---
section: Fixed
issue: 1257
---

**The built-in image redactor is bound by the image's header and by the number of regions**
(#1257, after the review of #1241): a PNG of 40 MP is about 18 KiB, and every region the model gave
allocated a full box of pixels — 150 boxes could take gigabytes of native memory. The size in the
header is now checked before a pixel is decoded (over 40 MP: `FileRedactionFailedError`, "the image
has more than 40000000 pixels"), an answer of more than 200 regions fails the redaction, and all
regions are painted in one pixel buffer: memory is one full-size image, however many regions there
are (a 6324 × 6324 PNG with 500 regions: 2315 MB peak before, 329 MB after). The reason names
counts only, never the model's text.
