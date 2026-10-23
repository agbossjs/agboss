/**
 * The HTML report's stylesheet (#397 PR 1), inline: colour tokens for light and dark
 * (`prefers-color-scheme`), system fonts only (no request), one column that reads at phone width,
 * focus always visible, status never by colour alone (the dots carry a symbol, the badges a word).
 */
export const REPORT_PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #5f5f5a; --border: #dcdcd6;
  --accent: #2856c9; --passed: #1e7a3c; --passed-bg: #e3f3e8; --failed: #b3261e; --failed-bg: #fbe6e4;
  --error: #8a4b00; --error-bg: #fbecd6; --limit: #5b3fa0; --limit-bg: #ece6f8;
  --unstable: #8a6100; --unstable-bg: #fbf1cf; --skipped: #5f5f5a; --skipped-bg: #ececea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --surface: #1e1e1c; --text: #ececea; --muted: #a9a9a3; --border: #3a3a37;
    --accent: #8fb0ff; --passed: #7fd59a; --passed-bg: #183522; --failed: #ff9d94; --failed-bg: #3d1a17;
    --error: #ffc078; --error-bg: #3a2610; --limit: #c6b2ff; --limit-bg: #2a2140;
    --unstable: #f2d16b; --unstable-bg: #352c0f; --skipped: #a9a9a3; --skipped-bg: #2b2b29;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main, .report-header, footer { max-width: 72rem; margin: 0 auto; padding: 0 16px; }
.report-header { padding-top: 24px; }
h1 { font-size: 1.6rem; margin: 0 0 12px; overflow-wrap: anywhere; }
h2 { font-size: 1.2rem; margin: 32px 0 12px; }
h3 { font-size: 1rem; margin: 0 0 6px; overflow-wrap: anywhere; }
a { color: var(--accent); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.eyebrow { margin: 0; color: var(--muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; }
.muted { color: var(--muted); }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 8px 24px; margin: 0; }
.facts div { min-width: 0; }
.facts dt { color: var(--muted); font-size: 0.8rem; }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.tiles { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; }
.tile-label { color: var(--muted); font-size: 0.85rem; }
.tile-value { font-size: 1.35rem; font-weight: 600; }
.tile-note { color: var(--muted); font-size: 0.8rem; }
.unstable-list li { margin: 4px 0; overflow-wrap: anywhere; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.filters button {
  font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border);
  border-radius: 999px; padding: 6px 14px; min-height: 36px; cursor: pointer;
}
.filters button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.cases { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.case article { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; min-width: 0; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 8px; }
.badge, .status { display: inline-block; border-radius: 6px; padding: 0 8px; font-size: 0.85rem; font-weight: 600; }
.badge-passed, .status-passed { color: var(--passed); background: var(--passed-bg); }
.badge-failed, .status-failed { color: var(--failed); background: var(--failed-bg); }
.badge-unstable { color: var(--unstable); background: var(--unstable-bg); }
.status-error { color: var(--error); background: var(--error-bg); }
.status-limit { color: var(--limit); background: var(--limit-bg); }
.status-skipped { color: var(--skipped); background: var(--skipped-bg); }
.attempts { list-style: none; padding: 0; margin: 0 0 8px; display: flex; flex-wrap: wrap; gap: 6px; }
.dot {
  display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px;
  border-radius: 50%; text-decoration: none; font-weight: 700; border: 2px solid currentColor;
}
.dot-passed { color: var(--passed); background: var(--passed-bg); }
.dot-failed { color: var(--failed); background: var(--failed-bg); }
.dot-error { color: var(--error); background: var(--error-bg); }
.dot-limit { color: var(--limit); background: var(--limit-bg); }
.first-failure { margin: 0 0 8px; overflow-wrap: anywhere; }
.run { border-top: 1px solid var(--border); padding: 6px 0; }
.run summary { cursor: pointer; padding: 4px 0; }
.run-error { overflow-wrap: anywhere; }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
caption { text-align: left; color: var(--muted); padding: 4px 0; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
td.number { text-align: right; white-space: nowrap; }
.badge-neutral { color: var(--muted); background: var(--skipped-bg); }
tr.verdict-regressed th, tr.verdict-regressed td { background: var(--failed-bg); }
.expectation, .timeline { margin: 8px 0; }
.step-part-title { margin: 8px 0 4px; font-weight: 600; font-size: 0.9rem; }
.steps { list-style: none; padding: 0 0 0 12px; margin: 0; border-left: 2px solid var(--border); }
.step { padding: 6px 0 6px 10px; position: relative; min-width: 0; }
.step::before { content: ""; position: absolute; left: -7px; top: 13px; width: 10px; height: 10px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); }
.step-head { margin: 0 0 4px; overflow-wrap: anywhere; }
.kind { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.step-part ul { margin: 0; padding-left: 18px; }
.step-part li { overflow-wrap: anywhere; }
.tool-call, .child { border: 1px solid var(--border); border-radius: 8px; padding: 4px 10px; margin: 6px 0; }
.tool-call summary, .child summary { cursor: pointer; overflow-wrap: anywhere; }
.child { background: var(--bg); }
.status-call-succeeded { color: var(--passed); background: var(--passed-bg); }
.status-call-failed, .status-call-blocked, .status-call-timed-out { color: var(--failed); background: var(--failed-bg); }
.status-call-invalid-arguments, .status-call-unknown-tool, .status-call-declined, .status-call-replied { color: var(--error); background: var(--error-bg); }
.value { margin: 6px 0; min-width: 0; }
.value figcaption { color: var(--muted); font-size: 0.8rem; }
.value pre { margin: 2px 0 0; padding: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; max-height: 24rem; font-size: 0.85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.labels { margin: 8px 0; }
.label-details { border: 1px dashed var(--border); border-radius: 8px; padding: 4px 10px; margin: 6px 0; }
.label-details summary { cursor: pointer; }
.label-form { display: grid; gap: 8px; margin: 8px 0; max-width: 32rem; }
.label-form fieldset { border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.label-form input[type="text"], .label-form select { font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; min-height: 36px; width: 100%; }
.label-form button { font: inherit; justify-self: start; color: var(--surface); background: var(--accent); border: 0; border-radius: 999px; padding: 8px 16px; min-height: 40px; cursor: pointer; }
.choice { display: inline-flex; align-items: center; gap: 4px; min-height: 32px; }
.calibration { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin: 0 0 12px; }
footer { color: var(--muted); font-size: 0.85rem; padding-top: 24px; padding-bottom: 32px; }
`;
