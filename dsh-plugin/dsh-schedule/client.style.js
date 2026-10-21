/**
 * Client styles. Every color/radius/elevation comes from a host theme
 * token (`--dsw-*`), except user-configured category accents. No theme
 * selectors or custom scrollbars.
 * Neutral borders are 0.5px; radius values ride the token scale.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.style.js',
  factory: () => `
.bsch-panel { display: flex; flex-direction: column; height: 100%; min-width: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
.bsch-tabs { display: flex; gap: 4px; padding: 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.bsch-tab { flex: 1; padding: 5px 10px; border: 0; border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; cursor: pointer; text-align: center; }
.bsch-tab:hover { background: var(--dsw-alias-bg-layer-1); }
.bsch-tab.is-active { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-weight: 500; }
.bsch-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }

.bsch-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex-wrap: wrap; }
.bsch-spacer { flex: 1; }
.bsch-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 20px; cursor: pointer; }
.bsch-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.bsch-btn.is-active { background: var(--dsw-alias-bg-layer-2); }
.bsch-btn.is-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); font-weight: 500; }
.bsch-btn.is-danger { color: var(--dsw-alias-state-error-primary); }
.bsch-btn:disabled { opacity: 0.5; cursor: default; }
.bsch-badge { padding: 1px 8px; border-radius: var(--dsw-radius-xs); border: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: nowrap; }
/* the week-range badge is the quick-jump trigger (R10-1): primary label
   color, pressed state while the popover is open */
.bsch-badge-btn { cursor: pointer; background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; }
.bsch-badge-btn:hover, .bsch-badge-btn.is-active { background: var(--dsw-alias-bg-layer-2); }
.bsch-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }

.bsch-strip { display: flex; gap: 6px; padding: 0 8px 6px; overflow-x: auto; flex-wrap: nowrap; }
.bsch-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 18px; white-space: nowrap; }
.bsch-chip.is-urgent { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.bsch-chip.is-overdue { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }

.bsch-gridwrap { flex: 1; min-height: 0; overflow-y: auto; position: relative; }
.bsch-grid { position: relative; display: grid; grid-template-columns: 34px repeat(7, minmax(78px, 1fr)); }
.bsch-grid-head { position: sticky; top: 0; z-index: 3; display: grid; grid-template-columns: 34px repeat(7, minmax(78px, 1fr)); background: var(--dsw-alias-bg-base); border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.bsch-grid-head > div { padding: 4px 2px; text-align: center; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.bsch-grid-head .is-today { color: var(--dsw-alias-brand-primary); font-weight: 500; }
.bsch-daycell { position: relative; border-left: 0.5px solid var(--dsw-alias-border-l1); touch-action: pan-y; }
.bsch-daycell.is-weekend { background: var(--dsw-alias-bg-layer-1); }
/* border-box keeps every row exactly 60px so hour lines stay on the
   minute→pixel lattice the blocks are positioned with (content-box would
   add each border to the row height and drift ~11px by 24:00). */
.bsch-hour { position: relative; box-sizing: border-box; height: 60px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.bsch-hour.is-dayboundary { border-bottom: 2px solid var(--dsw-alias-label-primary); }
.bsch-hour.is-nolabel .bsch-hourlabel { display: none; }
.bsch-hourlabel { position: absolute; top: -9px; right: 4px; font-size: 10px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.bsch-nowline { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid var(--dsw-alias-state-error-primary); z-index: 2; pointer-events: none; }

/* border-box: the inline top/left/width/height set by WeekGrid must include
   the block's own padding and 2px left border, otherwise every block grows
   ~6px wider and ~4px taller than its cell slice (content-box) and drifts
   past the day column's right and bottom lines. */
.bsch-block { position: absolute; left: 1px; right: auto; box-sizing: border-box; border-radius: var(--dsw-radius-xs); border-left: 2px solid var(--bsch-block-color, var(--dsw-alias-state-idle-primary)); background: color-mix(in srgb, var(--bsch-block-color, var(--dsw-alias-state-idle-primary)) 28%, transparent); padding: 2px 4px; font-size: 11px; line-height: 1.4; overflow: hidden; cursor: pointer; touch-action: none; }
.bsch-block:hover { background: color-mix(in srgb, var(--bsch-block-color, var(--dsw-alias-state-idle-primary)) 38%, transparent); }
.bsch-block.is-done { color: var(--dsw-alias-label-secondary); text-decoration: line-through; opacity: 0.65; }
.bsch-block.is-dragging { opacity: 0.5; z-index: 4; }
.bsch-block.is-selected { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
/* Drafts span their whole column — an absolute block without a width
   shrink-to-fits its label, which collapsed ghost/band to a sliver
   (R11-2). EventBlock keeps its own lane width inline. */
.bsch-block.is-ghost, .bsch-block.is-band { left: 1px; width: calc(100% - 2px); border: 0.5px dashed var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); color: var(--dsw-alias-label-secondary); cursor: pointer; }
.bsch-block.is-band { pointer-events: none; }
.bsch-marquee { position: absolute; border: 0.5px dashed var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); pointer-events: none; z-index: 5; }
.bsch-block-resize { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; cursor: ns-resize; }
.bsch-block-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bsch-block-sub { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.bsch-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 12px; }
.bsch-group { margin: 8px 0 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-weight: 500; }
.bsch-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; margin: 2px 0; border-radius: var(--dsw-radius-md); border: 0.5px solid transparent; }
.bsch-row:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
.bsch-row.is-done .bsch-row-title { color: var(--dsw-alias-label-secondary); text-decoration: line-through; }
.bsch-row-main { flex: 1; min-width: 0; }
.bsch-row-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.bsch-row-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.bsch-check { margin-top: 2px; accent-color: var(--dsw-alias-brand-primary); }
.bsch-prio { flex: none; width: 6px; height: 6px; margin-top: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-state-idle-primary); }
.bsch-prio.is-high { background: var(--dsw-alias-state-error-primary); }
.bsch-prio.is-medium { background: var(--dsw-alias-state-warn-primary); }
.bsch-prio.is-low { background: var(--dsw-alias-state-idle-primary); }

.bsch-progress { display: flex; align-items: center; gap: 8px; padding: 8px; }
.bsch-ring { flex: none; }
.bsch-ring text { fill: var(--dsw-alias-label-secondary); font-size: 10px; }

.bsch-modal-mask { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-3); display: flex; align-items: center; justify-content: center; z-index: 100; }
.bsch-modal { width: min(360px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow-y: auto; border-radius: var(--dsw-radius-panel); background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-panel); padding: 14px; }
.bsch-modal-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.bsch-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.bsch-field > label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.bsch-input, .bsch-select, .bsch-textarea { padding: 4px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 22px; width: 100%; box-sizing: border-box; }
.bsch-textarea { line-height: 1.5; resize: vertical; }
.bsch-input:focus, .bsch-select:focus, .bsch-textarea:focus { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.bsch-modal-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 12px; }
.bsch-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 4px 0; white-space: pre-wrap; }
.bsch-weekdays { display: flex; gap: 8px; flex-wrap: wrap; }
.bsch-weekday { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; cursor: pointer; }
.bsch-rowline > .bsch-field { flex: 1; min-width: 0; }

/* quick-jump mini calendar popover (legacy 快速跳转小日历) */
.bsch-popanchor { position: relative; }
.bsch-pop-mask { position: fixed; inset: 0; z-index: 9; }
/* bg-overlay is translucent in the host theme — paint an opaque base under
   the card so the grid/header behind does not show through (R10-2). */
.bsch-popover { position: absolute; top: calc(100% + 4px); left: 0; z-index: 10; background: var(--dsw-alias-bg-base); border-radius: var(--dsw-radius-md); }
.bsch-mc { width: 231px; padding: 8px; border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-panel); }
.bsch-mc-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-bottom: 4px; }
.bsch-mc-month { font-size: 12px; line-height: 20px; font-weight: 500; }
.bsch-mc-weekdays, .bsch-mc-grid { display: grid; grid-template-columns: repeat(7, 1fr); }
.bsch-mc-weekdays { margin-bottom: 2px; }
.bsch-mc-weekdays > span { text-align: center; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.bsch-mc-day { position: relative; box-sizing: border-box; display: flex; align-items: center; justify-content: center; height: 27px; border-radius: var(--dsw-radius-xs); font-size: 12px; cursor: pointer; }
.bsch-mc-day:hover { background: var(--dsw-alias-bg-layer-1); }
.bsch-mc-day.is-empty { cursor: default; }
.bsch-mc-day.is-today { outline: 1px solid var(--dsw-alias-brand-primary); }
.bsch-mc-dots { position: absolute; bottom: 2px; left: 50%; transform: translateX(-50%); display: flex; gap: 2px; }
.bsch-mc-dot { width: 4px; height: 4px; border-radius: 50%; }

.bsch-queue { display: flex; flex-direction: column; gap: 6px; padding: 8px; flex: 1; min-height: 0; overflow-y: auto; }
.bsch-queue-item { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.bsch-queue-item-bar { display: flex; gap: 4px; align-items: center; }
.bsch-queue-empty { padding: 24px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.bsch-preview { margin: 0 8px 8px; padding: 8px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); font-size: 12px; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }

.bsch-lock-switch { display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; padding: 2px 0; }
.bsch-switch-track { width: 28px; height: 16px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); position: relative; }
.bsch-lock-switch[aria-checked="true"] .bsch-switch-track { background: var(--dsw-alias-brand-primary); }
.bsch-switch-thumb { position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform .15s; }
.bsch-lock-switch[aria-checked="true"] .bsch-switch-thumb { transform: translateX(12px); background: var(--dsw-alias-bg-base); }
.bsch-settings { display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow-y: auto; }
.bsch-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--dsw-radius-xl); border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.bsch-category-list { container-type: inline-size; display: flex; flex-direction: column; gap: 6px; }
.bsch-category-row { display: grid; grid-template-columns: minmax(60px, 1fr) auto 24px minmax(80px, 120px); align-items: center; gap: 6px; }
.bsch-color-picker { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.bsch-color-picker input { width: 26px; height: 24px; padding: 1px; border: 0; background: transparent; cursor: pointer; }
@container (max-width: 420px) { .bsch-color-picker span { display: none; } }
.bsch-category-row > .bsch-btn { justify-content: center; padding: 1px; font-size: 16px; }
.bsch-btn:focus-visible, .bsch-lock-switch:focus-visible, .bsch-color-picker input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.bsch-category-preview { position: relative; width: auto; min-height: 30px; padding: 3px 6px; font-size: 10px; pointer-events: none; }
.bsch-card h3 { margin: 0; font-size: 13px; font-weight: 600; }
.bsch-rowline { display: flex; align-items: center; gap: 8px; }
.bsch-rowline > .bsch-input, .bsch-rowline > .bsch-select { flex: 1; }

.bsch-icon { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: inherit; }

/* reminder notifications (client.notify.js): a transient card stack in the
   host page; system notifications take over when the page is in the
   background and permission is granted. */
.bsch-toast-host { position: fixed; right: 16px; bottom: 16px; z-index: 200; display: flex; flex-direction: column; gap: 8px; max-width: min(340px, calc(100vw - 32px)); pointer-events: none; }
.bsch-toast { pointer-events: auto; padding: 10px 12px; border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary); }
.bsch-toast-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.bsch-toast-body { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
`,
})
