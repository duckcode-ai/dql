export const APP_STUDIO_V2_STYLES = `
.dql-studio-v2, .dql-studio-v2-launch, .dql-app-studio-home, .dql-studio-v2-loading { width:100%; min-height:0; color:var(--text-primary); font-family:var(--font-sans, Inter, ui-sans-serif, system-ui); }
.dql-studio-v2, .dql-studio-v2-launch, .dql-studio-v2-loading { height:100%; background:var(--bg-canvas); }
.dql-studio-v2 button, .dql-studio-v2 input, .dql-studio-v2 textarea, .dql-studio-v2 select, .dql-studio-v2-launch button, .dql-studio-v2-launch input, .dql-studio-v2-launch textarea, .dql-app-studio-home button, .dql-app-studio-home input, .dql-app-studio-home textarea, .dql-studio-v2-loading button { font:inherit; color:inherit; }
.dql-studio-v2 button, .dql-studio-v2-launch button, .dql-app-studio-home button, .dql-studio-v2-loading button { cursor:pointer; }
.dql-studio-v2 .icon, .dql-studio-v2-launch .icon, .dql-studio-v2-loading .icon { width:34px; height:34px; border:1px solid var(--border-default); border-radius:9px; background:var(--bg-1); display:inline-flex; align-items:center; justify-content:center; padding:0; }
.dql-studio-v2 .icon:hover, .dql-studio-v2-launch .icon:hover, .dql-studio-v2-loading .icon:hover { background:var(--bg-2); border-color:var(--border-strong); }
.dql-studio-v2 .icon:disabled { opacity:.35; cursor:default; }

.dql-studio-v2-launch { overflow:auto; }
.dql-studio-v2-launch > header { height:66px; padding:0 28px; border-bottom:1px solid var(--border-subtle); display:flex; align-items:center; gap:14px; background:color-mix(in srgb,var(--bg-0) 92%,transparent); position:sticky; top:0; z-index:4; }
.dql-studio-v2-launch > header > div { display:grid; gap:2px; }
.dql-studio-v2-launch > header span { color:var(--text-tertiary); font-size:11px; text-transform:uppercase; letter-spacing:.12em; }
.dql-studio-v2-launch > header strong { font-size:14px; }
.dql-studio-v2-launch > main { width:min(1120px,calc(100% - 48px)); margin:0 auto; padding:64px 0 80px; display:grid; grid-template-columns:minmax(280px,.85fr) minmax(520px,1.35fr); gap:56px; align-items:start; }
.dql-app-studio-home { display:grid; grid-template-columns:minmax(300px,.82fr) minmax(520px,1.18fr); gap:clamp(34px,4vw,62px); align-items:center; padding:44px 0 56px; border-bottom:1px solid var(--border-subtle); }
.dql-app-studio-home .dql-studio-v2-intro { position:static; padding:18px 0; }
.dql-studio-v2-intro { position:sticky; top:120px; padding:18px 0; }
.dql-studio-v2-intro .eyebrow { display:inline-flex; align-items:center; gap:7px; color:var(--accent); font-size:12px; font-weight:750; text-transform:uppercase; letter-spacing:.1em; }
.dql-studio-v2-intro h1 { font-size:clamp(38px,4.3vw,62px); line-height:1.02; letter-spacing:-.05em; margin:22px 0; max-width:650px; }
.dql-studio-v2-intro p { color:var(--text-secondary); font-size:16px; line-height:1.65; max-width:490px; }
.dql-studio-v2-start-card { background:var(--bg-0); border:1px solid var(--border-default); border-radius:20px; padding:26px; box-shadow:0 18px 54px color-mix(in srgb,var(--text-primary) 7%,transparent); display:grid; gap:22px; }
.mode-switch { background:var(--bg-2); border-radius:12px; padding:4px; display:grid; grid-template-columns:1fr 1fr; gap:4px; }
.mode-switch button { border:0; border-radius:9px; background:transparent; padding:11px 10px; color:var(--text-secondary); display:flex; align-items:center; justify-content:center; gap:8px; font-size:11px; font-weight:700; white-space:nowrap; }
.mode-switch button.on { background:var(--bg-0); color:var(--text-primary); box-shadow:0 1px 5px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.primary-field { display:grid; gap:8px; }
.primary-field > span, .launch-label { font-size:12px; font-weight:750; color:var(--text-secondary); }
.primary-field textarea, .primary-field input { width:100%; box-sizing:border-box; border:1px solid var(--border-default); background:var(--bg-1); border-radius:12px; padding:14px; resize:vertical; outline:none; line-height:1.5; }
.primary-field textarea:focus, .primary-field input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
.template-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.template-grid button { border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:12px; padding:14px; text-align:left; display:grid; grid-template-columns:28px 1fr; gap:3px 8px; }
.template-grid button > span { grid-row:1/3; color:var(--text-tertiary); }
.template-grid button strong { font-size:13px; }
.template-grid button small { color:var(--text-tertiary); line-height:1.35; }
.template-grid button.on { border-color:var(--accent); background:var(--accent-dim); }
.template-grid button.on > span { color:var(--accent); }
.studio-source-policy-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.1fr); gap:10px; }
.studio-source-policy-row > div, .studio-review-toggle { min-width:0; min-height:70px; box-sizing:border-box; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-1); padding:13px; display:flex; align-items:center; gap:10px; }
.studio-source-policy-row p, .studio-review-toggle span { min-width:0; margin:0; display:grid; gap:3px; }
.studio-source-policy-row strong { font-size:11px; line-height:1.3; }
.studio-source-policy-row small { color:var(--text-tertiary); font-size:9.5px; line-height:1.4; }
.policy-mark { flex:0 0 auto; width:31px; height:31px; border-radius:9px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.studio-review-toggle { cursor:pointer; }
.studio-review-toggle input { display:none; }
.studio-review-toggle i { flex:0 0 auto; width:34px; height:20px; border-radius:20px; background:var(--border-strong); position:relative; transition:.15s; }
.studio-review-toggle i:after { content:''; position:absolute; width:14px; height:14px; left:3px; top:3px; border-radius:50%; background:var(--bg-0); transition:.15s; }
.studio-review-toggle input:checked + i { background:var(--accent); }
.studio-review-toggle input:checked + i:after { transform:translateX(14px); }
.studio-review-toggle:has(input:checked) { border-color:var(--accent); background:var(--accent-dim); }
.policy-toggle { display:grid; grid-template-columns:1fr 36px 1fr; align-items:center; gap:12px; border:1px solid var(--border-subtle); border-radius:12px; padding:13px; }
.policy-toggle > span { display:grid; grid-template-columns:22px 1fr; align-items:center; }
.policy-toggle span svg { grid-row:1/3; color:var(--accent); }
.policy-toggle b { font-size:12px; }
.policy-toggle small { grid-column:2; color:var(--text-tertiary); font-size:10px; }
.policy-toggle input { display:none; }
.policy-toggle i { width:34px; height:20px; border-radius:20px; background:var(--border-strong); position:relative; }
.policy-toggle i:after { content:''; position:absolute; width:14px; height:14px; left:3px; top:3px; border-radius:50%; background:var(--bg-0); transition:.15s; }
.policy-toggle input:checked + i { background:var(--accent); }
.policy-toggle input:checked + i:after { transform:translateX(14px); }
.launch-action { min-height:46px; border:0; border-radius:11px; background:var(--accent); color:var(--accent-fg) !important; font-weight:800; display:flex; align-items:center; justify-content:center; gap:8px; }
.launch-action:hover { background:var(--accent-hover); }
.launch-action:disabled { opacity:.5; cursor:default; }
.recent-drafts { grid-column:2; display:grid; gap:8px; }
.recent-drafts > header { color:var(--text-tertiary); font-size:12px; font-weight:700; display:flex; align-items:center; gap:6px; }
.recent-drafts > button { border:1px solid var(--border-subtle); border-radius:10px; background:var(--bg-1); padding:11px 13px; display:flex; justify-content:space-between; }
.recent-drafts > button span { color:var(--text-tertiary); font-size:11px; }

.dql-studio-v2-loading { position:relative; display:grid; place-items:center; padding:24px; box-sizing:border-box; }
.dql-studio-v2-loading > .icon { position:absolute; top:16px; left:16px; }
.dql-studio-v2-loading > div { width:min(380px,100%); display:grid; justify-items:center; gap:9px; text-align:center; }
.dql-studio-v2-loading .loading-mark { width:46px; height:46px; border-radius:14px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); animation:studio-loading-pulse 1.4s ease-in-out infinite; }
.dql-studio-v2-loading strong { margin-top:7px; font-size:15px; }
.dql-studio-v2-loading small { color:var(--text-tertiary); font-size:10.5px; line-height:1.55; }
.dql-studio-v2-loading > div > button { margin-top:7px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); padding:8px 12px; font-size:11px; font-weight:700; }
@keyframes studio-loading-pulse { 50% { transform:translateY(-2px); box-shadow:0 8px 24px var(--accent-dim); } }

.dql-studio-v2 { display:grid; grid-template-columns:300px minmax(0,1fr) 300px; grid-template-rows:58px minmax(0,1fr); overflow:hidden; }
.studio-topbar { grid-column:1/4; height:58px; border-bottom:1px solid var(--border-subtle); background:var(--bg-0); display:grid; grid-template-columns:300px minmax(200px,1fr) auto; align-items:center; z-index:6; }
.studio-brand { height:100%; display:flex; align-items:center; gap:9px; padding:0 12px; border-right:1px solid var(--border-subtle); }
.studio-brand .mark { width:29px; height:29px; border-radius:8px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; }
.studio-brand > div { display:grid; min-width:0; }
.studio-brand input { border:0; background:transparent; font-weight:800; width:145px; outline:none; padding:0; }
.studio-brand small { color:var(--text-tertiary); font-size:10px; }
.page-nav { height:100%; display:flex; align-items:center; gap:3px; overflow:auto; padding:0 18px; }
.page-nav > button:not(.icon) { border:0; background:transparent; padding:8px 11px; border-radius:8px; color:var(--text-tertiary); font-size:12px; font-weight:700; white-space:nowrap; }
.page-nav > button.on { background:var(--bg-2); color:var(--text-primary); }
.studio-actions { position:relative; display:flex; align-items:center; gap:6px; padding-right:12px; }
.breakpoints { display:flex; background:var(--bg-2); border-radius:9px; padding:3px; }
.breakpoints button { width:29px; height:27px; border:0; border-radius:6px; background:transparent; display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); }
.breakpoints button.on { background:var(--bg-0); color:var(--accent); box-shadow:0 1px 4px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.review-state { display:inline-flex; gap:5px; align-items:center; border:1px solid var(--border-default); border-radius:999px; padding:6px 9px; font-size:10px; color:var(--text-secondary); white-space:nowrap; }
.review-state.needs-review { color:#a16207; border-color:color-mix(in srgb,#a16207 32%,var(--border-default)); }
.studio-actions .publish { border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); padding:9px 13px; font-size:11px; font-weight:800; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .preview { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:8px 11px; font-size:10px; font-weight:750; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .preview:hover { border-color:var(--border-strong); background:var(--bg-2); }
.studio-overflow-menu { position:absolute; z-index:20; top:43px; right:10px; width:174px; padding:5px; border:1px solid var(--border-default); border-radius:9px; background:var(--bg-0); box-shadow:0 12px 34px color-mix(in srgb,var(--text-primary) 14%,transparent); }
.studio-overflow-menu button { width:100%; border:0; border-radius:6px; background:transparent; color:#b91c1c; padding:9px; display:flex; align-items:center; gap:7px; text-align:left; font-size:10px; font-weight:750; }
.studio-overflow-menu button:hover { background:color-mix(in srgb,#dc2626 9%,var(--bg-0)); }

.studio-left, .studio-right { min-height:0; background:var(--bg-0); }
.studio-left { grid-column:1; grid-row:2; border-right:1px solid var(--border-subtle); display:grid; grid-template-columns:64px 1fr; }
.studio-left > nav { border-right:1px solid var(--border-subtle); padding:10px 6px; display:flex; flex-direction:column; gap:5px; }
.studio-left > nav button { border:0; background:transparent; border-radius:9px; padding:8px 3px; min-height:48px; color:var(--text-tertiary); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; font-size:9px; }
.studio-left > nav button.on { background:var(--accent-dim); color:var(--accent); }
.left-content { min-width:0; overflow:auto; padding:14px 11px; }
.mobile-drawer-close { display:none; }
.panel-title { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:12px; }
.panel-title > div { display:grid; gap:2px; }
.panel-title strong { font-size:13px; }
.panel-title small { font-size:10px; color:var(--text-tertiary); line-height:1.3; }
.panel-title button { width:27px; height:27px; border:1px solid var(--border-default); border-radius:7px; background:var(--bg-1); display:flex; align-items:center; justify-content:center; }
.studio-search { display:flex; align-items:center; gap:6px; border:1px solid var(--border-subtle); border-radius:8px; padding:0 8px; margin-bottom:10px; color:var(--text-tertiary); }
.studio-search input { min-width:0; width:100%; border:0; outline:0; background:transparent; padding:8px 0; font-size:11px; }
.studio-list, .source-list, .filter-list, .template-list { display:grid; gap:6px; }
.studio-list > button, .filter-list > button, .template-list > button, .filter-list > div { border:1px solid transparent; background:transparent; border-radius:9px; padding:8px; display:flex; align-items:center; gap:8px; text-align:left; }
.studio-list > button:hover, .filter-list > button:hover, .template-list > button:hover { background:var(--bg-2); }
.studio-list > button.on, .template-list > button.on { border-color:var(--accent); background:var(--accent-dim); }
.studio-list > button > span, .filter-list > button > span, .filter-list > div > span, .template-list > button > span { width:28px; height:28px; flex:none; border-radius:7px; background:var(--bg-2); display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); }
.studio-list button div, .filter-list button div, .filter-list > div div, .template-list button div { min-width:0; display:grid; flex:1; gap:2px; }
.studio-list strong, .filter-list strong, .template-list strong { font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-list small, .filter-list small, .template-list small { font-size:9.5px; color:var(--text-tertiary); line-height:1.3; }
.filter-workflow { display:grid; gap:5px; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:10px; padding:9px; margin-bottom:12px; }
.filter-workflow span { display:flex; align-items:center; gap:7px; color:var(--text-secondary); font-size:9.5px; }
.filter-workflow b { width:18px; height:18px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:var(--accent-dim); color:var(--accent); font-size:8px; }
.filter-remove { width:26px; height:26px; flex:none; border:0; border-radius:6px; background:transparent; color:var(--text-tertiary); display:flex; align-items:center; justify-content:center; }
.filter-remove:hover { background:var(--bg-2); color:#b91c1c; }
.panel-empty.compact { padding:8px 2px; font-size:9.5px; }
.studio-add-steps { display:flex; align-items:center; gap:7px; margin:-2px 0 12px; color:var(--text-secondary); font-size:9px; font-weight:750; }
.studio-add-steps span { display:flex; align-items:center; gap:5px; white-space:nowrap; }
.studio-add-steps b { width:18px; height:18px; border-radius:50%; background:var(--accent-dim); color:var(--accent); display:inline-flex; align-items:center; justify-content:center; font-size:9px; }
.studio-add-steps i { height:1px; min-width:10px; flex:1; background:var(--border-default); }
.selected-source-card { border:1px solid color-mix(in srgb,var(--accent) 42%,var(--border-default)); background:color-mix(in srgb,var(--accent-dim) 44%,var(--bg-0)); border-radius:12px; padding:11px; margin-bottom:15px; display:grid; gap:9px; }
.selected-source-card header { display:flex; align-items:center; gap:8px; }
.selected-source-card header > span, .source-select > span { width:30px; height:30px; flex:none; border-radius:8px; background:var(--bg-1); display:flex; align-items:center; justify-content:center; }
.selected-source-card .certified, .source-select > span.certified, .studio-source-ready .certified { color:#15803d; background:color-mix(in srgb,#16a34a 10%,var(--bg-1)); }
.selected-source-card .review, .source-select > span.review { color:#a16207; }
.selected-source-card header div { min-width:0; display:grid; gap:1px; }
.selected-source-card header small { color:var(--text-tertiary); font-size:8px; text-transform:uppercase; letter-spacing:.08em; }
.selected-source-card header strong { font-size:12px; overflow-wrap:anywhere; }
.selected-source-card p { margin:0; color:var(--text-secondary); font-size:9.5px; line-height:1.45; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.source-filter-availability { display:flex; align-items:center; gap:6px; border-radius:7px; padding:6px 7px; background:var(--bg-1); color:var(--text-secondary); font-size:9px; line-height:1.35; }
.source-filter-availability svg { color:var(--accent); flex:none; }
.add-recommended { min-height:34px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg) !important; display:flex; align-items:center; justify-content:center; gap:6px; font-size:10px; font-weight:800; }
.source-view-options { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
.source-view-options button { border:1px solid var(--border-default); background:var(--bg-0); border-radius:7px; padding:6px 3px; display:flex; justify-content:center; align-items:center; gap:4px; font-size:9px; }
.source-prompt { border:1px dashed var(--border-strong); border-radius:10px; padding:11px; margin-bottom:15px; display:flex; gap:9px; color:var(--accent); }
.source-prompt div { display:grid; gap:2px; }
.source-prompt strong { color:var(--text-primary); font-size:10px; }
.source-prompt small { color:var(--text-tertiary); font-size:9px; line-height:1.35; }
.panel-section-label { display:flex; align-items:baseline; justify-content:space-between; margin:14px 2px 7px; gap:8px; }
.panel-section-label span { color:var(--text-secondary); font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
.panel-section-label small { color:var(--text-muted); font-size:8px; }
.source-row { border:1px solid transparent; border-radius:9px; display:grid; grid-template-columns:minmax(0,1fr) 30px; align-items:center; padding:3px; }
.source-row:hover { background:var(--bg-2); }
.source-row.on { border-color:var(--accent); background:var(--accent-dim); }
.source-select { min-width:0; border:0; background:transparent; padding:5px; display:flex; align-items:center; gap:8px; text-align:left; }
.source-select div { min-width:0; display:grid; gap:2px; }
.source-select strong { font-size:10.5px; line-height:1.25; white-space:normal; overflow-wrap:anywhere; }
.source-select small { color:var(--text-tertiary); font-size:8.5px; }
.source-quick-add { width:27px; height:27px; border:1px solid var(--border-default); background:var(--bg-0); color:var(--accent) !important; border-radius:7px; display:flex; align-items:center; justify-content:center; }
.content-quick-add { display:grid; gap:6px; }
.content-quick-add button { border:1px solid var(--border-subtle); background:transparent; border-radius:9px; padding:8px; display:flex; align-items:center; gap:8px; text-align:left; }
.content-quick-add button:hover { background:var(--bg-2); }
.content-quick-add button > span { flex:1; display:grid; gap:2px; }
.content-quick-add strong { font-size:10.5px; }
.content-quick-add small { color:var(--text-tertiary); font-size:8.5px; }
.panel-empty { color:var(--text-tertiary); font-size:11px; line-height:1.5; padding:10px; }

.studio-workspace { grid-column:2; grid-row:2; min-width:0; min-height:0; overflow:auto; background:var(--bg-canvas); padding:24px; position:relative; }
.studio-canvas-frame { margin:0 auto; transition:width .18s ease; }
.studio-canvas-frame.wide { width:min(100%,1260px); }
.studio-canvas-frame.medium { width:min(100%,760px); }
.studio-canvas-frame.narrow { width:min(100%,390px); }
.studio-canvas-frame.preview-mode-auto { width:100%; }
.studio-canvas-label { display:flex; justify-content:space-between; align-items:center; color:var(--text-tertiary); font-size:9px; padding:0 4px 7px; }
.studio-canvas-label > div { display:grid; gap:2px; }
.studio-canvas-label > div > span { text-transform:uppercase; letter-spacing:.09em; }
.studio-canvas-label > div > small { color:var(--text-muted); font-size:8.5px; }
.studio-canvas-label button { border:0; background:transparent; color:var(--text-secondary); display:flex; align-items:center; gap:5px; padding:4px 6px; border-radius:6px; font-size:9px; font-weight:700; text-transform:none; letter-spacing:0; }
.studio-canvas-label button:hover { background:var(--bg-2); color:var(--text-primary); }
.studio-canvas-label button:disabled { opacity:.4; cursor:default; }
.studio-canvas { min-height:calc(100vh - 145px); background:var(--bg-0); border:1px solid var(--border-default); border-radius:14px; box-shadow:0 12px 36px color-mix(in srgb,var(--text-primary) 6%,transparent); padding:28px; }
.studio-page-heading { display:flex; align-items:end; justify-content:space-between; border-bottom:1px solid var(--border-subtle); padding-bottom:17px; margin-bottom:16px; }
.studio-page-heading > div { display:grid; gap:3px; }
.studio-page-heading > div > small { font-size:8px; font-weight:800; letter-spacing:.12em; color:var(--accent); }
.studio-page-heading span { font-size:22px; font-weight:820; letter-spacing:-.025em; }
.studio-page-heading > small { color:var(--text-tertiary); font-size:10px; }
.studio-source-ready { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border-default)); background:color-mix(in srgb,var(--accent-dim) 38%,var(--bg-0)); border-radius:10px; padding:8px 9px; margin-bottom:12px; }
.studio-source-ready > div { display:flex; align-items:center; gap:8px; min-width:0; }
.studio-source-ready > div > span { width:28px; height:28px; border-radius:7px; display:flex; align-items:center; justify-content:center; flex:none; }
.studio-source-ready p { margin:0; display:grid; min-width:0; }
.studio-source-ready p small { color:var(--text-tertiary); font-size:8px; }
.studio-source-ready p strong { font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-source-actions { display:flex; align-items:center; gap:5px; }
.studio-source-actions > button { border:0; background:var(--accent); color:var(--accent-fg) !important; border-radius:7px; padding:7px 9px; display:flex; align-items:center; gap:5px; white-space:nowrap; font-size:9px; font-weight:800; }
.studio-source-actions > .source-clear { width:30px; height:30px; padding:0; justify-content:center; background:var(--bg-1); color:var(--text-secondary) !important; border:1px solid var(--border-default); }
.studio-page-filterbar { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:16px; }
.studio-filter { min-height:36px; border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:4px 8px; display:grid; gap:1px; }
.studio-filter > span { color:var(--text-tertiary); font-size:8px; font-weight:750; }
.studio-filter input, .studio-filter select { min-width:100px; border:0; outline:0; background:transparent; padding:0; font-size:10px; }
.studio-filter.range { grid-template-columns:1fr auto 1fr; align-items:end; }
.studio-filter.range > span { grid-column:1/-1; }
.studio-filter.range input { min-width:112px; }
.studio-filter.range i { align-self:center; color:var(--text-muted); font-style:normal; }
.studio-filter.boolean { display:flex; align-items:center; gap:6px; }
.studio-filter.boolean input { min-width:0; }
.studio-filter.boolean span { font-size:10px; color:var(--text-secondary); }
.studio-page-grid { position:static; display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:12px; align-items:start; pointer-events:auto; background:none; }
.medium .studio-page-grid { grid-template-columns:repeat(6,minmax(0,1fr)); }
.narrow .studio-page-grid { grid-template-columns:1fr; }
.studio-component-card { grid-column:span var(--studio-tile-width); min-height:150px; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:11px; padding:0; text-align:left; overflow:hidden; }
.narrow .studio-component-card { grid-column:1; }
.studio-component-card:hover { border-color:var(--border-strong); }
.studio-component-card.selected { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.studio-component-card.dragging { opacity:.55; border-style:dashed; }
.studio-component-card > header { height:38px; padding:0 11px; display:flex; align-items:center; gap:6px; border-bottom:1px solid var(--border-subtle); }
.drag-handle { color:var(--text-muted); cursor:grab; font-size:15px; line-height:1; }
.studio-component-card > header strong { font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-component-card > header small { margin-left:auto; color:var(--text-tertiary); font-size:8px; text-transform:uppercase; }
.tile-filter-notice { display:flex; align-items:center; gap:5px; margin:8px 10px 0; padding:6px 8px; border-radius:7px; background:var(--bg-2); color:var(--text-secondary); font-size:9px; line-height:1.35; }
.tile-filter-notice svg { flex:0 0 auto; color:var(--text-tertiary); }
.trust-dot { width:7px; height:7px; border-radius:50%; background:var(--text-muted); display:inline-block; flex:none; }
.trust-dot.certified { background:#16a34a; }
.trust-dot.review_required { background:#d97706; }
.trust-dot.draft_ready { background:var(--accent); }
.tile-heading { padding:22px 16px; font-size:19px; font-weight:800; }
.tile-text { padding:16px; font-size:12px; color:var(--text-secondary); line-height:1.55; }
.preview-kpi { padding:18px; display:grid; gap:4px; }
.preview-kpi strong { font-size:32px; letter-spacing:-.04em; }
.preview-kpi span { color:var(--text-tertiary); font-size:10px; }
.preview-chart { height:120px; padding:18px 18px 12px; display:flex; align-items:end; gap:8px; }
.preview-chart i { flex:1; min-width:5px; background:var(--accent-dim); border:1px solid color-mix(in srgb,var(--accent) 30%,transparent); border-radius:4px 4px 1px 1px; }
.preview-table { padding:13px; display:grid; gap:7px; }
.preview-table i { display:grid; grid-template-columns:1fr 1.6fr .7fr; gap:8px; }
.preview-table span { height:9px; border-radius:4px; background:var(--bg-3); }
.live-component-preview { height:calc(100% - 39px); min-height:150px; overflow:hidden; padding:5px 8px 8px; box-sizing:border-box; cursor:default; }
.live-component-preview > div { width:100%; height:100%; }
.preview-state { min-height:150px; padding:24px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; text-align:center; color:var(--text-tertiary); }
.preview-state strong { color:var(--text-secondary); font-size:11px; }
.preview-state span { max-width:360px; font-size:10px; line-height:1.45; }
.preview-state.error strong { color:#b91c1c; }
.empty-canvas { grid-column:1/-1; min-height:330px; border:1px dashed var(--border-strong); border-radius:12px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:30px; }
.empty-canvas > span { width:46px; height:46px; border-radius:13px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; }
.empty-canvas strong { margin-top:14px; }
.empty-canvas p { color:var(--text-tertiary); font-size:11px; max-width:320px; }
.empty-canvas button { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); padding:8px 12px; font-size:11px; font-weight:700; }
.studio-error { border:1px solid color-mix(in srgb,#dc2626 35%,var(--border-default)); background:color-mix(in srgb,#dc2626 8%,var(--bg-0)); color:#b91c1c; border-radius:9px; padding:10px 12px; font-size:11px; }
.studio-error.floating { position:sticky; top:0; z-index:4; margin:0 auto 10px; max-width:800px; display:flex; justify-content:space-between; }
.studio-error button { border:0; background:transparent; color:inherit; }

.studio-right { grid-column:3; grid-row:2; border-left:1px solid var(--border-subtle); overflow:auto; }
.studio-right > header { height:46px; border-bottom:1px solid var(--border-subtle); padding:0 12px; display:flex; align-items:center; justify-content:space-between; }
.studio-right > header > div { display:flex; align-items:center; gap:7px; font-size:11px; }
.inspector-body { padding:14px; display:grid; gap:16px; }
.inspector-body section { display:grid; gap:7px; }
.field-help { color:var(--text-tertiary); font-size:9px; line-height:1.45; }
.review-action { border:1px solid var(--accent); background:var(--accent-dim); color:var(--accent); border-radius:8px; padding:9px; display:flex; align-items:center; justify-content:center; gap:6px; font-size:10px; font-weight:750; }
.review-action:disabled { border-color:var(--border-default); background:var(--bg-2); color:var(--text-muted); cursor:default; }
.review-task-list > div { border:1px solid var(--border-subtle); border-radius:8px; padding:8px; display:grid; gap:7px; }
.review-task-list span { color:var(--text-secondary); font-size:9px; line-height:1.4; }
.review-task-list button { justify-self:start; border:0; background:transparent; color:var(--accent); padding:0; display:flex; gap:4px; align-items:center; font-size:9px; font-weight:750; }
.inspector-body label { color:var(--text-tertiary); font-size:9px; text-transform:uppercase; letter-spacing:.09em; font-weight:800; }
.inspector-body input, .inspector-body textarea, .inspector-body select { width:100%; box-sizing:border-box; border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 10px; outline:none; font-size:11px; }
.field-mapping > div, .format-grid > div { display:grid; grid-template-columns:74px minmax(0,1fr); gap:7px; align-items:center; }
.field-mapping > div span, .format-grid > div span { color:var(--text-tertiary); font-size:9px; }
.frame-facts > div { border-bottom:1px solid var(--border-subtle); padding:7px 0; display:flex; justify-content:space-between; gap:10px; }
.frame-facts span { color:var(--text-tertiary); font-size:10px; }
.frame-facts strong { font-size:10px; text-align:right; }
.ask-ai { border:0; background:var(--accent); color:var(--accent-fg) !important; border-radius:9px; padding:10px; display:flex; align-items:center; justify-content:center; gap:7px; font-size:11px; font-weight:800; }
.trust-summary { grid-template-columns:24px 1fr !important; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:9px; padding:11px; color:var(--accent); }
.trust-summary div { display:grid; gap:3px; }
.trust-summary strong { font-size:10px; color:var(--text-primary); }
.trust-summary p { margin:0; color:var(--text-tertiary); font-size:9px; line-height:1.4; }
.size-buttons { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
.size-buttons button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:7px; padding:7px; font-size:10px; }
.data-trust > div { display:flex; align-items:center; gap:7px; }
.data-trust p { color:var(--text-tertiary); font-size:10px; margin:0; line-height:1.5; }
.delete-component { border:1px solid color-mix(in srgb,#dc2626 25%,var(--border-default)); color:#b91c1c !important; background:transparent; border-radius:8px; padding:9px; display:flex; align-items:center; justify-content:center; gap:6px; font-size:10px; }
.inspector-id { color:var(--text-muted); font-size:8px; text-align:center; }

.proposal-scrim { position:fixed; inset:0; z-index:30; background:color-mix(in srgb,var(--bg-canvas) 68%,transparent); backdrop-filter:blur(5px); display:flex; align-items:center; justify-content:center; padding:24px; }
.proposal-card { width:min(620px,100%); max-height:calc(100vh - 48px); overflow:auto; border:1px solid var(--border-default); background:var(--bg-0); border-radius:16px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); }
.proposal-card > header { padding:18px; display:flex; gap:11px; align-items:center; border-bottom:1px solid var(--border-subtle); }
.proposal-card > header > span { width:34px; height:34px; border-radius:10px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; }
.proposal-card > header > div { display:grid; gap:3px; flex:1; }
.proposal-card > header small { color:var(--text-tertiary); font-size:10px; }
.proposal-summary { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:16px 18px; }
.proposal-summary div { background:var(--bg-1); border:1px solid var(--border-subtle); border-radius:9px; padding:10px; display:grid; }
.proposal-summary strong { font-size:20px; }
.proposal-summary span { color:var(--text-tertiary); font-size:9px; }
.proposal-clarifications { margin:0 18px 14px; border:1px solid color-mix(in srgb,#d97706 30%,var(--border-default)); background:color-mix(in srgb,#d97706 7%,var(--bg-0)); border-radius:9px; padding:11px; display:grid; gap:9px; }
.proposal-clarifications > strong { font-size:10px; color:#a16207; }
.proposal-clarifications > div { display:flex; gap:5px; align-items:center; flex-wrap:wrap; }
.proposal-clarifications span { width:100%; font-size:10px; }
.proposal-clarifications button { border:1px solid var(--border-default); background:var(--bg-0); border-radius:999px; padding:5px 8px; font-size:9px; }
.proposal-clarifications button.on { border-color:var(--accent); color:var(--accent); background:var(--accent-dim); display:inline-flex; align-items:center; gap:4px; }
.proposal-change-list { padding:0 18px 18px; display:grid; gap:8px; }
.proposal-change-list span { display:flex; align-items:center; gap:7px; color:var(--text-secondary); font-size:11px; }
.proposal-change-list svg { color:#16a34a; }
.proposal-card > footer { padding:14px 18px; border-top:1px solid var(--border-subtle); display:flex; justify-content:flex-end; gap:8px; }
.proposal-card > footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 12px; font-size:10px; font-weight:700; }
.proposal-card > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); display:flex; align-items:center; gap:6px; }
.studio-delete-card { width:min(420px,100%); border:1px solid var(--border-default); background:var(--bg-0); border-radius:16px; padding:24px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); }
.studio-delete-card .delete-mark { width:40px; height:40px; border-radius:11px; display:flex; align-items:center; justify-content:center; color:#b91c1c; background:color-mix(in srgb,#dc2626 9%,var(--bg-0)); }
.studio-delete-card h2 { margin:15px 0 7px; font-size:18px; }
.studio-delete-card p { margin:0; color:var(--text-secondary); font-size:11px; line-height:1.6; }
.studio-delete-card footer { display:flex; justify-content:flex-end; gap:8px; margin-top:22px; }
.studio-delete-card footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 12px; font-size:10px; font-weight:750; }
.studio-delete-card footer button.danger { border-color:#dc2626; background:#dc2626; color:white; }

@media (max-width:1240px) {
  .dql-studio-v2 { grid-template-columns:300px minmax(0,1fr); }
  .studio-topbar { grid-column:1/3; grid-template-columns:300px minmax(160px,1fr) auto; }
  .studio-right { display:none; }
  .studio-right.has-selection { display:block; position:fixed; z-index:18; right:0; top:106px; bottom:0; width:min(330px,calc(100vw - 64px)); border:1px solid var(--border-default); border-right:0; background:var(--bg-0); box-shadow:-12px 0 36px color-mix(in srgb,var(--text-primary) 13%,transparent); }
  .studio-actions .review-state { display:none; }
}
@media (max-width:900px) {
  .dql-studio-v2-launch > main { grid-template-columns:1fr; width:min(100% - 28px,620px); padding-top:28px; gap:22px; }
  .dql-app-studio-home { grid-template-columns:1fr; padding:28px 0 38px; gap:18px; }
  .dql-studio-v2-intro { position:static; }
  .dql-studio-v2-intro h1 { font-size:38px; }
  .recent-drafts { grid-column:1; }
  .dql-studio-v2 { grid-template-columns:64px minmax(0,1fr); }
  .studio-topbar { grid-column:1/3; grid-template-columns:60px minmax(0,1fr) auto; }
  .studio-brand { padding:0 12px; }
  .studio-brand .mark, .studio-brand > div { display:none; }
  .page-nav { padding:0 8px; }
  .studio-actions .breakpoints, .studio-actions > .icon, .studio-actions .review-state { display:none; }
  .studio-actions > .overflow-button { display:flex; }
  .studio-actions { padding-right:8px; gap:5px; }
  .studio-actions .preview, .studio-actions .publish { width:36px; height:34px; padding:0; justify-content:center; }
  .studio-actions .preview span, .studio-actions .publish span { display:none; }
  .studio-left { grid-template-columns:64px; }
  .left-content { display:none; position:fixed; z-index:12; left:108px; top:106px; bottom:0; width:min(286px,calc(100vw - 108px)); background:var(--bg-0); border-right:1px solid var(--border-default); box-shadow:8px 0 24px color-mix(in srgb,var(--text-primary) 10%,transparent); padding-top:44px; }
  .left-content.open { display:block; }
  .mobile-drawer-close { display:flex; position:absolute; right:10px; top:9px; width:28px; height:28px; align-items:center; justify-content:center; border:1px solid var(--border-default); border-radius:7px; background:var(--bg-1); color:var(--text-secondary); }
  .studio-workspace { padding:12px; }
  .studio-canvas { padding:16px; }
  .studio-page-heading { align-items:flex-start; gap:8px; }
  .studio-page-heading > small { text-align:right; }
  .studio-source-ready { align-items:flex-start; flex-direction:column; }
  .template-grid { grid-template-columns:1fr; }
  .policy-toggle { grid-template-columns:1fr 36px; }
  .policy-toggle > span:last-child { grid-column:1/-1; }
}
@media (max-width:620px) {
  .dql-app-studio-home .dql-studio-v2-start-card { padding:16px; border-radius:15px; }
  .dql-app-studio-home .dql-studio-v2-intro h1 { font-size:34px; }
  .studio-source-policy-row { grid-template-columns:1fr; }
}
@media (prefers-reduced-motion:reduce) { .studio-canvas-frame, .policy-toggle i:after, .studio-review-toggle i:after, .dql-studio-v2-loading .loading-mark { transition:none; animation:none; } }
`;
