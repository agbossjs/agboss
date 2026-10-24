import { REPORT_PAGE_STYLE } from "../../eval/html/page-style.js";

/**
 * The Hub page's stylesheet (#401 PR 3): the eval report's (#397 — colour tokens for light and
 * dark, system fonts, one column at phone width, visible focus) and the mesh graph's own rules.
 * Inline like the report's, allowed by its hash.
 */
export const HUB_PAGE_STYLE = `${REPORT_PAGE_STYLE}
.mesh-graph { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px; overflow-x: auto; }
.mesh-graph svg { display: block; width: 100%; height: auto; min-width: 36rem; }
.mesh-edge { stroke: var(--muted); stroke-width: 1.5; fill: none; }
.mesh-arrow { fill: var(--muted); }
.mesh-edge-label { fill: var(--muted); font-size: 12px; }
.mesh-edge-declared { stroke-dasharray: 6 4; }
line.mesh-edge-broken { stroke: var(--failed); }
text.mesh-edge-broken { fill: var(--failed); }
tr.federation-broken td { background: var(--failed-bg); }
.federation-problems { padding-left: 18px; }
.federation-problems p { margin: 2px 0; overflow-wrap: anywhere; }
.mesh-node rect { fill: var(--surface); stroke: var(--accent); stroke-width: 2; }
.mesh-node.mesh-undescribed rect { stroke: var(--muted); stroke-dasharray: 4 3; }
.mesh-node text { fill: var(--text); font-size: 13px; font-weight: 600; }
.mesh-node .mesh-node-note { fill: var(--muted); font-size: 11px; font-weight: 400; }
.mesh-node:focus-visible rect { stroke-width: 4; }
.applications { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.application { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px; min-width: 0; }
.workflow { border-top: 1px solid var(--border); padding: 6px 0; }
.workflow summary { cursor: pointer; overflow-wrap: anywhere; }
.parts { margin: 4px 0 0; padding-left: 18px; }
.parts li { overflow-wrap: anywhere; }
.trees { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.tree-root { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; }
.tree-root summary { cursor: pointer; overflow-wrap: anywhere; }
.tree { list-style: none; margin: 4px 0 0; padding: 0 0 0 14px; border-left: 2px solid var(--border); }
.tree p { margin: 4px 0; overflow-wrap: anywhere; }
.tree-stub { color: var(--muted); font-style: italic; }
tr.radar-candidate td { background: var(--passed-bg); }
`;
