// Every colour, radius and duration here is an app design token
// (src/renderer/src/styles/tokens.css) so the graph tracks both themes and the
// user's accent. Query and name fields are the SDK's shared `.search-field`
// (Bookmarks design) and change only through its `--search-field-*` tokens.
const CSS = `
.graphview-source-intro {
  margin: var(--space-3) 0;
  padding: var(--space-3);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  background: var(--container-color-alt);
  color: var(--text-secondary);
  font-size: var(--smaller-font-size);
  line-height: 1.5;
}
.graphview-source-intro p { margin: 0; }

.graphview-source-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.graphview-query .search-field > .search-field-action,
.graphview-namebar .search-field > .search-field-action,
.graphview-new {
  box-sizing: border-box;
  padding: 3px;
  background-clip: content-box;
}

.graphview-panel { display:flex; flex-direction:column; height:100%; min-height:0; }
.graphview-stage { position:relative; display:flex; flex-direction:column; flex:1 1 auto; min-height:0; }
.graphview-canvas-wrap { position:relative; flex:1 1 auto; min-height:0; overflow:hidden; }
/* Same token the label halo is read from at draw time (GraphCanvas), so the
   halo matches the backdrop exactly instead of sitting a shade off it. */
.graphview-canvas { width:100%; height:100%; background:var(--surface-color-alt); color:var(--text-secondary); }
.graphview-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  color:var(--text-secondary); font-size:0.75rem; text-align:center; padding:0 16px; pointer-events:none; }

/* Every stacked bar includes its separator in the shared height. */
.graphview-topbar, .graphview-searchbar, .graphview-namebar, .graphview-chipbar, .graphview-depthbar {
  box-sizing:border-box; height:var(--app-bar-height); min-height:var(--app-bar-height);
  max-height:var(--app-bar-height); flex:0 0 var(--app-bar-height); border-bottom:1px solid var(--border-light); }
.graphview-topbar { position:relative; display:flex; align-items:center;
  padding:0 calc(var(--plugin-actions-offset, 0px) + var(--space-3)) 0 calc(var(--plugin-navigation-offset, 0px) + var(--space-3));
  background:var(--container-color-alt); }
.graphview-topbar-title { position:absolute; left:50%; transform:translateX(-50%);
  max-width:max(0px, calc(100% - 2 * max(calc(var(--plugin-navigation-offset, 0px) + var(--space-3)), calc(var(--plugin-actions-offset, 0px) + var(--space-3)))));
  color:var(--text-secondary); font-size:var(--smaller-font-size); font-weight:400; pointer-events:none; }
.graphview-title-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.graphview-searchbar { background:var(--container-color-alt); }
.graphview-find { display:flex; flex:1 1 auto; width:100%; min-width:0; }
.graphview-find-count { flex:0 0 auto; font-size:0.6875rem; font-variant-numeric:tabular-nums; color:var(--search-field-placeholder); }

/* Workspace color legend. */
.graphview-legend { position:absolute; left:var(--space-3); bottom:var(--space-3); z-index:1; display:flex; flex-direction:column; gap:3px;
  max-width:min(260px, 45%); max-height:45%; overflow:auto; box-sizing:border-box; padding:6px 8px;
  border:1px solid var(--border-light); border-radius:var(--radius-sm); background:var(--container-color-alt);
  font-size:0.6875rem; color:var(--text-secondary); }
.graphview-legend-item { display:flex; align-items:center; gap:6px; min-width:0; }
.graphview-legend-dot { flex:0 0 auto; width:8px; height:8px; border-radius:50%; }
.graphview-legend-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* ---- the Filters / Color groups / Display controls -------------------- */
.graphview-controls { display:flex; flex-direction:column; flex:1 1 auto; min-height:0; }

.graphview-chipbar { display:flex; align-items:center; gap:var(--space-1); flex:0 0 auto;
  padding:0 6px; }
.graphview-chip { display:inline-flex; align-items:center; justify-content:center; width:28px; height:26px;
  flex:0 0 auto; padding:0; border:none; border-radius:6px; background:transparent;
  color:var(--text-secondary); cursor:pointer;
  transition: background-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
.graphview-chip svg { width:16px; height:16px; }
.graphview-chip:hover { background:var(--hover-bg); color:var(--text-color); }
.graphview-chip.active { background:var(--accent-tint-bg); color:var(--accent-tint-text); }

.graphview-body { display:flex; flex-direction:column; gap:10px; min-height:0; overflow-y:auto;
  padding:10px; }
.graphview-section-label { font-size:0.6875rem; font-weight:700; letter-spacing:.03em; text-transform:uppercase;
  color:var(--text-secondary); }
/* Groups a block inside a section (Forces under Display) — a divider, not a header. */
.graphview-subsection-label { margin-top:4px; padding-top:10px; border-top:1px solid var(--border-light);
  font-size:0.6875rem; font-weight:700; letter-spacing:.03em; text-transform:uppercase;
  color:var(--text-tertiary, var(--text-secondary)); }

.graphview-row { display:flex; align-items:center; gap:8px; min-height:26px; font-size:0.75rem; color:var(--text-color); }
.graphview-row-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.graphview-slider-row { display:flex; flex-direction:column; gap:3px; }
.graphview-slider-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px;
  font-size:0.75rem; color:var(--text-color); }
.graphview-value { font-size:0.6875rem; font-variant-numeric:tabular-nums; color:var(--text-secondary); }

/* Same 2px line + 10px thumb as the app-wide .media-slider; the caller sets
   --slider-fill inline. Local copy because globals.css classes are the shell's,
   not a plugin's contract. */
.graphview-slider { --slider-fill:0%; -webkit-appearance:none; appearance:none; width:100%; height:14px;
  background:transparent; cursor:pointer; }
.graphview-slider::-webkit-slider-runnable-track { height:14px;
  background-image:
    linear-gradient(var(--accent-color), var(--accent-color)),
    linear-gradient(var(--container-color-light), var(--container-color-light));
  background-size: var(--slider-fill) 2px, 100% 2px;
  background-position:left center, left center; background-repeat:no-repeat; }
.graphview-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:10px; height:10px;
  border-radius:50%; background:var(--accent-color); margin-top:2px; }

/* Query rows: the base ("Whole vault" until narrowed), exclusions and color
   groups. The flex cell sizes the full-width shared field beside its siblings. */
.graphview-group { display:flex; align-items:center; gap:6px; }
.graphview-query { display:flex; flex:1 1 auto; min-width:0; }
.graphview-base[data-empty='true'] { --search-field-placeholder:var(--search-field-text); }
.graphview-count { flex:0 0 auto; font-size:0.6875rem; font-variant-numeric:tabular-nums; color:var(--text-tertiary); }
.graphview-color-group { position:relative; transition:box-shadow var(--duration-fast) var(--ease-out); }
.graphview-color-group[data-reorder-over='true'][data-drop-position='before'] { box-shadow:0 -2px 0 var(--accent-color); }
.graphview-color-group[data-reorder-over='true'][data-drop-position='after'] { box-shadow:0 2px 0 var(--accent-color); }
.graphview-group-handle { display:grid; place-items:center; flex:0 0 auto; width:20px; height:26px; padding:0;
  border:none; border-radius:var(--radius-sm); background:none; color:var(--text-tertiary); cursor:grab; }
.graphview-group-handle:hover, .graphview-group-handle:focus-visible { background:var(--hover-bg); color:var(--text-color); }
.graphview-group-handle:active { cursor:grabbing; }
.graphview-group-handle svg { width:14px; height:14px; }

.graphview-btn-accent { padding:7px 11px; border:1px solid var(--accent-color); border-radius:7px;
  background:var(--accent-color); color:#fff; font-size:0.75rem; font-weight:600; cursor:pointer; }
.graphview-btn-accent:hover { filter:brightness(1.06); }
.graphview-hint { font-size:0.65625rem; line-height:1.4; color:var(--text-tertiary); }

/* ---- the graph name row -------------------------------------------------- */
/* One 38px row under the panel header, with its own separator. Naming swaps
   the name button for an input inside the same field frame. */
.graphview-namebar { border-bottom:1px solid var(--border-light); }
.graphview-name-cell { display:flex; flex:1 1 auto; min-width:0; }
.graphview-name-field { cursor:pointer; text-align:left; -webkit-app-region:no-drag; }
div.graphview-name-field { cursor:text; }
.graphview-name-field[data-invalid='true'] { --search-field-border:var(--danger-tint-text); --search-field-border-hover:var(--danger-tint-text); --search-field-focus:var(--danger-tint-text); }
.graphview-name-text { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.graphview-name-field[data-default='true'] .graphview-name-text { color:var(--text-secondary); }
.graphview-new { flex:0 0 auto; }

/* The left-sidebar panel's action group: the open-page button, pinned right of
   the shared .panel-title. The panel header is a window drag region, so every
   control in it must opt out. */
.graphview-panel-actions { display:flex; align-items:center; gap:2px; flex:0 0 auto;
  margin-left:auto; min-width:0; -webkit-app-region:no-drag; }

/* Local (right-sidebar) graph: controls stack above a short canvas — a floating
   card would cover the whole thing at sidebar width. */
.graphview-local-controls { display:flex; flex-direction:column; flex:0 1 auto; min-height:0; max-height:60%; }
.graphview-depthbar { display:flex; align-items:center; gap:8px; padding:0 10px; font-size:var(--smaller-font-size); }
.graphview-depthbar .graphview-slider { flex:1 1 auto; min-width:0; width:auto; }
.graphview-depthbar .graphview-value { min-width:2ch; text-align:right; }
.graphview-search-results { flex:1 1 auto; min-height:0; overflow:auto; padding:var(--space-2); }
.graphview-search-result { display:flex; flex-direction:column; gap:2px; width:100%; padding:6px 8px; text-align:left;
  border:0; border-radius:var(--radius-sm); color:var(--text-color); background:transparent; cursor:pointer; }
.graphview-search-result span, .graphview-search-result small { width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.graphview-search-result small { font-size:var(--smallest-font-size); color:var(--text-secondary); }
.graphview-search-result:hover { background:var(--hover-bg); }
.graphview-search-result.active { background:var(--accent-tint-bg); color:var(--accent-tint-text); }
.graphview-settings { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; }
.graphview-info { padding:var(--space-3); overflow-y:auto; }
.graphview-info .props-info-table { margin:0; }
.graphview-info-heading { margin:var(--space-4) 0 var(--space-2); font-size:var(--smaller-font-size); font-weight:600; color:var(--text-secondary); }
`

export function injectStyles(): () => void {
  const id = 'graphview-styles'
  // Rewrite in place — an early return would keep a stale sheet across a
  // plugin hot-reload.
  const existing = document.getElementById(id)
  if (existing) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return () => {
      if (document.getElementById(id) === existing) existing.remove()
    }
  }
  const el = document.createElement('style')
  el.id = id
  el.textContent = CSS
  document.head.appendChild(el)
  return () => {
    if (document.getElementById(id) === el) el.remove()
  }
}
