/**
 * Style chunk of @buaaer/dsh-schedule-buaa. Self-contained so the settings
 * card renders even if the core's style chunk has not loaded yet; tokens
 * only (`--dsw-*`).
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule-buaa/client.style.js',
  factory: () => `
.bbua-settings { display: flex; flex-direction: column; gap: 12px; padding: 12px; overflow-y: auto; }
.bbua-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--dsw-radius-xl); border: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.bbua-card h3 { margin: 0; font-size: 13px; font-weight: 600; }
.bbua-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.bbua-field > label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.bbua-input { padding: 4px 8px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 22px; width: 100%; box-sizing: border-box; }
.bbua-input:focus { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.bbua-rowline { display: flex; align-items: center; gap: 8px; }
.bbua-spacer { flex: 1; }
.bbua-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.bbua-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; margin: 4px 0; white-space: pre-wrap; }
.bbua-btn { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 20px; cursor: pointer; }
.bbua-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.bbua-btn.is-primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: var(--dsw-alias-bg-base); font-weight: 500; }
.bbua-btn:disabled { opacity: 0.5; cursor: default; }
`,
})
