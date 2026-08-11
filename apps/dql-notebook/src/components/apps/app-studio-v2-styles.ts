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
.ai-launch-explainer { display:flex; align-items:flex-start; gap:10px; border:1px solid color-mix(in srgb,var(--accent) 24%,var(--border-default)); background:color-mix(in srgb,var(--accent-dim) 36%,var(--bg-0)); border-radius:12px; padding:12px; }
.ai-launch-explainer > span { width:32px; height:32px; flex:none; border-radius:9px; display:grid; place-items:center; color:var(--accent); background:var(--bg-0); }
.ai-launch-explainer > div { display:grid; gap:3px; }
.ai-launch-explainer strong { font-size:11px; line-height:1.35; }
.ai-launch-explainer small { color:var(--text-tertiary); font-size:9.5px; line-height:1.45; }
.launch-options { border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-1); overflow:hidden; }
.launch-options > summary { list-style:none; min-height:44px; padding:0 13px; display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:9px; cursor:pointer; color:var(--text-secondary); font-size:11px; }
.launch-options > summary::-webkit-details-marker { display:none; }
.launch-options > summary strong { justify-self:end; color:var(--text-primary); font-size:10.5px; }
.launch-options > summary svg { transition:transform .15s; }
.launch-options[open] > summary { border-bottom:1px solid var(--border-subtle); }
.launch-options[open] > summary svg { transform:rotate(180deg); }
.launch-options .template-grid { padding:12px; }
.template-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.template-grid button { border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:12px; padding:14px; text-align:left; display:grid; grid-template-columns:28px 1fr; gap:3px 8px; }
.template-grid button > span { grid-row:1/3; color:var(--text-tertiary); }
.template-grid button strong { font-size:13px; }
.template-grid button small { color:var(--text-tertiary); line-height:1.35; }
.template-grid button.on { border-color:var(--accent); background:var(--accent-dim); }
.template-grid button.on > span { color:var(--accent); }
.studio-source-policy-row { display:grid; grid-template-columns:1fr; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-1); overflow:hidden; }
.studio-source-policy-row > header, .studio-review-toggle { min-width:0; min-height:54px; box-sizing:border-box; padding:11px 13px; display:flex; align-items:center; gap:10px; }
.studio-source-policy-row > header { border-bottom:1px solid var(--border-subtle); }
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
.studio-review-toggle:has(input:checked) { background:var(--accent-dim); }
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
.launch-next-step { display:block; margin-top:-13px; color:var(--text-tertiary); font-size:9px; text-align:center; line-height:1.4; }
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
.studio-ai-activity-label { min-height:18px; color:var(--accent) !important; font-size:12px !important; font-weight:800; }
.studio-ai-activity-actions { display:flex; justify-content:center; flex-wrap:wrap; gap:7px; }
.dql-studio-v2-loading .studio-ai-activity-actions > button { margin-top:7px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); padding:8px 12px; font-size:11px; font-weight:700; }
.dql-studio-v2-loading .studio-ai-activity-actions > button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
@keyframes studio-loading-pulse { 50% { transform:translateY(-2px); box-shadow:0 8px 24px var(--accent-dim); } }

.dql-studio-v2 { position:relative; display:grid; grid-template-columns:300px minmax(0,1fr) clamp(280px,24vw,360px); grid-template-rows:58px minmax(0,1fr); overflow:hidden; }
.studio-topbar { grid-column:1/4; height:58px; border-bottom:1px solid var(--border-subtle); background:var(--bg-0); display:grid; grid-template-columns:300px minmax(200px,1fr) auto; align-items:center; z-index:6; }
.dql-studio-v2.proposal-focus { grid-template-columns:minmax(0,1fr); }
.proposal-focus .studio-topbar { grid-column:1; grid-template-columns:300px minmax(260px,1fr) 300px; }
.proposal-focus .studio-workspace { grid-column:1; grid-row:2; padding:clamp(18px,3vw,42px); }
.proposal-focus-title { min-width:0; display:grid; justify-items:center; gap:2px; }
.proposal-focus-title small { color:var(--accent); font-size:8px; font-weight:800; letter-spacing:.1em; }
.proposal-focus-title strong { font-size:12px; }
.proposal-focus-status { justify-self:end; margin-right:16px; display:flex; align-items:center; gap:6px; color:var(--text-secondary); font-size:9.5px; }
.proposal-focus-status svg { color:#15803d; }
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
.studio-actions .publish { border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); padding:9px 13px; font-size:11px; font-weight:800; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .publish small { padding-left:6px; border-left:1px solid color-mix(in srgb,var(--accent-fg) 34%,transparent); color:inherit; font-size:8px; font-weight:750; }
.studio-actions .preview { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:8px 11px; font-size:10px; font-weight:750; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .preview:hover { border-color:var(--border-strong); background:var(--bg-2); }
.studio-actions .copilot { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:8px 10px; font-size:10px; font-weight:750; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .copilot:hover, .studio-actions .copilot.on { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
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
.studio-list, .filter-list, .template-list { display:grid; gap:6px; }
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
.filter-workflow small { color:var(--text-tertiary); font-size:8.5px; line-height:1.4; padding:3px 0 0 25px; }
.filter-remove { width:26px; height:26px; flex:none; border:0; border-radius:6px; background:transparent; color:var(--text-tertiary); display:flex; align-items:center; justify-content:center; }
.filter-remove:hover { background:var(--bg-2); color:#b91c1c; }
.panel-empty.compact { padding:8px 2px; font-size:9.5px; }
.filter-contract-list { display:grid; gap:7px; }
.filter-contract-list article { display:grid; grid-template-columns:minmax(0,1fr) 28px; align-items:center; border:1px solid var(--border-subtle); border-radius:10px; background:var(--bg-1); overflow:hidden; }
.filter-contract-summary { min-width:0; border:0; background:transparent; padding:9px; display:flex; align-items:center; gap:8px; text-align:left; }
.filter-contract-summary > span { width:30px; height:30px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.filter-contract-summary > div { min-width:0; display:grid; flex:1; gap:1px; }
.filter-contract-summary strong { font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-contract-summary small { color:var(--text-secondary); font-size:8.5px; }
.filter-contract-summary em { color:var(--text-tertiary); font-size:8px; font-style:normal; }
.filter-contract-summary > svg { color:var(--text-tertiary); flex:none; }
.filter-contract-list article > .filter-remove { margin-right:4px; }
.filter-empty { border:1px dashed var(--border-default); border-radius:11px; padding:17px 13px; display:grid; justify-items:start; gap:6px; background:var(--bg-1); }
.filter-empty > span { width:34px; height:34px; border-radius:9px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.filter-empty strong { font-size:11px; }
.filter-empty p { margin:0; color:var(--text-tertiary); font-size:9px; line-height:1.45; }
.filter-empty button, .filter-add-another { min-height:30px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-0); display:flex; align-items:center; justify-content:center; gap:5px; color:var(--text-primary); font-size:9px; font-weight:750; }
.filter-empty button { margin-top:3px; padding:0 10px; color:var(--accent); border-color:color-mix(in srgb,var(--accent) 36%,var(--border-default)); }
.filter-add-another { width:100%; margin-top:10px; }
.filter-field-search { height:38px; border:1px solid var(--border-default); border-radius:9px; padding:0 9px; display:flex; align-items:center; gap:7px; color:var(--text-tertiary); background:var(--bg-1); }
.filter-field-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.filter-field-search input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:var(--text-primary); font-size:10px; }
.filter-field-results { display:grid; gap:6px; margin-top:9px; }
.filter-field-results > button { width:100%; border:1px solid var(--border-subtle); border-radius:9px; padding:8px; background:var(--bg-1); display:flex; align-items:center; gap:8px; text-align:left; }
.filter-field-results > button:hover { border-color:var(--accent); background:var(--accent-dim); }
.filter-field-results > button > span { width:29px; height:29px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--bg-0); }
.filter-field-results > button > div { min-width:0; display:grid; flex:1; gap:1px; }
.filter-field-results strong { font-size:10px; }
.filter-field-results small { color:var(--text-secondary); font-size:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-field-results em { color:var(--text-tertiary); font-size:7.8px; font-style:normal; }
.filter-field-results > button > svg { color:var(--text-tertiary); transform:rotate(-90deg); }
.filter-builder { display:grid; gap:11px; }
.filter-builder > label { display:grid; gap:5px; }
.filter-builder > label > span, .filter-builder legend { color:var(--text-secondary); font-size:8.5px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
.filter-builder > label > input, .filter-builder > label > select { width:100%; height:35px; border:1px solid var(--border-default); border-radius:8px; padding:0 9px; outline:0; color:var(--text-primary); background:var(--bg-1); font-size:10px; }
.filter-builder > label > input:focus, .filter-builder > label > select:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.filter-availability { border:1px solid var(--border-subtle); border-radius:9px; padding:8px; display:grid; grid-template-columns:27px minmax(0,1fr) auto; align-items:center; gap:8px; background:var(--bg-1); }
.filter-availability > span { width:27px; height:27px; border-radius:7px; display:grid; place-items:center; color:var(--text-tertiary); background:var(--bg-2); }
.filter-availability > div { min-width:0; display:grid; gap:2px; }
.filter-availability strong { font-size:9.5px; }
.filter-availability small { color:var(--text-tertiary); font-size:8px; line-height:1.35; }
.filter-availability button { min-height:29px; border:1px solid var(--border-default); border-radius:7px; padding:0 8px; display:flex; align-items:center; gap:4px; background:var(--bg-0); color:var(--text-secondary); font-size:8px; font-weight:750; }
.filter-availability.ready { border-color:color-mix(in srgb,#16a34a 24%,var(--border-default)); background:color-mix(in srgb,#16a34a 5%,var(--bg-0)); }
.filter-availability.ready > span { color:#15803d; background:color-mix(in srgb,#16a34a 10%,var(--bg-0)); }
.filter-availability.empty { border-color:color-mix(in srgb,#d97706 32%,var(--border-default)); background:color-mix(in srgb,#d97706 5%,var(--bg-0)); }
.filter-availability.empty > span { color:#a16207; background:color-mix(in srgb,#d97706 10%,var(--bg-0)); }
.filter-builder-field { border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border-default)); border-radius:9px; padding:8px; background:var(--accent-dim); display:flex; align-items:center; gap:8px; }
.filter-builder-field > span { width:29px; height:29px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--bg-0); }
.filter-builder-field > div { min-width:0; display:grid; flex:1; gap:1px; }
.filter-builder-field small { color:var(--text-tertiary); font-size:7.5px; font-weight:800; letter-spacing:.07em; }
.filter-builder-field strong { font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-builder-field button { border:0; background:transparent; color:var(--accent); font-size:8.5px; font-weight:750; }
.filter-builder fieldset { min-width:0; margin:0; padding:0; border:0; display:grid; gap:6px; }
.filter-builder fieldset > small { color:var(--text-tertiary); font-size:8px; line-height:1.4; }
.filter-scope-switch { display:grid; grid-template-columns:1fr 1.35fr; gap:3px; border-radius:9px; padding:3px; background:var(--bg-2); }
.filter-scope-switch button { min-height:30px; border:0; border-radius:7px; background:transparent; color:var(--text-tertiary); font-size:8.5px; font-weight:750; }
.filter-scope-switch button.on { background:var(--bg-0); color:var(--text-primary); box-shadow:0 1px 3px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.filter-mapping { border:1px solid var(--border-subtle) !important; border-radius:10px; padding:9px !important; background:var(--bg-1); }
.filter-mapping legend { padding:0 4px; }
.filter-mapping > header { display:flex; align-items:center; justify-content:space-between; gap:6px; }
.filter-mapping > header span { color:var(--text-tertiary); font-size:8px; }
.filter-mapping > header button { border:0; background:transparent; color:var(--accent); font-size:8px; font-weight:800; }
.filter-mapping > div { max-height:300px; overflow:auto; display:grid; gap:8px; }
.filter-mapping > div > section { display:grid; gap:4px; }
.filter-mapping > div > section > small { padding:3px 2px 1px; color:var(--text-secondary); font-size:8px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
.filter-mapping label { min-width:0; border:1px solid var(--border-subtle); border-radius:8px; padding:7px; display:grid; grid-template-columns:15px minmax(0,1fr) 14px; align-items:center; gap:6px; background:var(--bg-0); }
.filter-mapping label:has(input:checked) { border-color:color-mix(in srgb,var(--accent) 42%,var(--border-default)); background:var(--accent-dim); }
.filter-mapping label.unsupported { opacity:.64; background:var(--bg-2); }
.filter-mapping label > input { width:13px; height:13px; accent-color:var(--accent); }
.filter-mapping label > span { min-width:0; display:grid; gap:1px; }
.filter-mapping label strong { font-size:9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-mapping label small { color:var(--text-tertiary); font-size:7.5px; line-height:1.3; overflow-wrap:anywhere; }
.filter-mapping label > svg { color:var(--accent); }
.filter-mapping label.unsupported > svg { color:var(--text-muted); }
.filter-required { grid-template-columns:15px minmax(0,1fr) !important; align-items:start; gap:7px !important; }
.filter-required > input { width:14px !important; height:14px !important; padding:0 !important; accent-color:var(--accent); }
.filter-required > span { display:grid; gap:1px; text-transform:none !important; letter-spacing:0 !important; }
.filter-required strong { font-size:9px; }
.filter-required small { color:var(--text-tertiary); font-size:8px; font-weight:500; }
.filter-builder-actions { display:grid; grid-template-columns:1fr 1.5fr; gap:6px; padding-top:2px; }
.filter-builder-actions button { min-height:34px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-0); color:var(--text-secondary); font-size:9px; font-weight:800; }
.filter-builder-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.filter-builder-actions button:disabled { opacity:.45; cursor:not-allowed; }
.source-search-primary { position:sticky; top:-14px; z-index:3; display:grid; grid-template-columns:16px minmax(0,1fr) 24px; align-items:center; gap:7px; min-height:41px; margin:-3px 0 10px; padding:0 8px; border:1px solid var(--border-default); border-radius:10px; color:var(--text-tertiary); background:var(--bg-0); box-shadow:0 8px 16px color-mix(in srgb,var(--bg-0) 76%,transparent); }
.source-search-primary:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim),0 8px 16px color-mix(in srgb,var(--bg-0) 76%,transparent); }
.source-search-primary input { min-width:0; width:100%; border:0; outline:0; background:transparent; color:var(--text-primary); font-size:10.5px; }
.source-search-primary input::placeholder { color:var(--text-muted); }
.source-search-primary button { width:24px; height:24px; border:0; border-radius:6px; display:grid; place-items:center; color:var(--text-tertiary); background:transparent; }
.source-search-primary button:hover { color:var(--text-primary); background:var(--bg-2); }
.used-sources-disclosure { margin:0 0 10px; border:1px solid var(--border-subtle); border-radius:10px; background:var(--bg-1); overflow:hidden; }
.used-sources-disclosure summary { min-height:43px; padding:8px 9px; display:grid; grid-template-columns:minmax(0,1fr) auto 15px; align-items:center; gap:7px; cursor:pointer; list-style:none; }
.used-sources-disclosure summary::-webkit-details-marker { display:none; }
.used-sources-disclosure summary > div { display:grid; gap:1px; }
.used-sources-disclosure summary strong { font-size:10.5px; }
.used-sources-disclosure summary small { color:var(--text-tertiary); font-size:8.5px; }
.used-sources-disclosure summary > span { min-width:21px; height:20px; padding:0 6px; border-radius:10px; display:grid; place-items:center; background:var(--bg-2); color:var(--text-secondary); font-size:8.5px; font-weight:800; }
.used-sources-disclosure summary > svg { color:var(--text-tertiary); transition:transform .14s ease; }
.used-sources-disclosure[open] summary > svg { transform:rotate(180deg); }
.used-sources-disclosure[open] summary { border-bottom:1px solid var(--border-subtle); }
.used-sources-disclosure .used-source-list, .used-sources-disclosure .source-panel-state { margin:0; padding:7px; }
.source-catalog-toolbar { min-width:0; display:grid; grid-template-columns:minmax(0,1fr); gap:5px; margin:10px 0 8px; }
.source-catalog-toolbar > small { min-width:0; justify-self:end; color:var(--text-muted); font-size:8px; text-align:right; }
.source-view-tabs { min-width:0; width:100%; box-sizing:border-box; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:3px; padding:3px; border-radius:8px; background:var(--bg-2); }
.source-view-tabs button { min-width:0; min-height:25px; padding:0 3px; border:0; border-radius:6px; color:var(--text-tertiary); background:transparent; font-size:8.5px; font-weight:750; }
.source-view-tabs button.on { color:var(--text-primary); background:var(--bg-0); box-shadow:0 1px 3px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.source-catalog-list { display:grid; gap:6px; }
.source-catalog-row { display:grid; grid-template-columns:minmax(0,1fr); border:1px solid var(--border-subtle); border-radius:10px; background:var(--bg-0); overflow:hidden; }
.source-catalog-row:hover { border-color:var(--border-default); background:var(--bg-1); }
.source-catalog-row.on { border-color:var(--accent); background:color-mix(in srgb,var(--accent-dim) 42%,var(--bg-0)); }
.source-catalog-summary { min-width:0; width:100%; border:0; background:transparent; padding:8px 8px 5px; display:flex; align-items:center; gap:8px; text-align:left; }
.source-catalog-summary > span { width:29px; height:29px; flex:none; border-radius:8px; background:var(--bg-1); display:flex; align-items:center; justify-content:center; }
.source-catalog-summary > span.certified, .studio-source-ready .certified { color:#15803d; background:color-mix(in srgb,#16a34a 10%,var(--bg-1)); }
.source-catalog-summary > span.review { color:#a16207; background:color-mix(in srgb,#d97706 9%,var(--bg-1)); }
.source-catalog-summary > div { min-width:0; display:grid; gap:2px; }
.source-catalog-summary strong { font-size:10.5px; line-height:1.22; white-space:normal; overflow-wrap:break-word; }
.source-catalog-summary small { color:var(--text-tertiary); font-size:8.3px; line-height:1.3; }
.source-add-view { min-height:28px; margin:0 8px 8px 45px; padding:5px 8px; border:1px solid color-mix(in srgb,var(--accent) 34%,var(--border-default)); border-radius:7px; background:var(--bg-0); color:var(--accent) !important; display:flex; align-items:center; justify-content:center; gap:4px; white-space:normal; line-height:1.25; font-size:8.5px; font-weight:800; }
.source-add-view:hover { background:var(--accent-dim); border-color:var(--accent); }
.source-add-view:disabled, .source-view-options button:disabled, .content-quick-add button:disabled { cursor:wait; opacity:.5; }
.source-action-feedback { margin:-3px 8px 8px 45px; color:var(--text-tertiary); font-size:8px; line-height:1.35; overflow-wrap:anywhere; }
.source-action-feedback.added { color:#15803d; }
.source-action-feedback.error { color:#b91c1c; }
.source-catalog-detail { padding:0 8px 9px 45px; display:grid; gap:7px; }
.source-catalog-detail > p { margin:0; color:var(--text-secondary); font-size:8.8px; line-height:1.42; }
.source-catalog-detail > span { display:flex; align-items:center; gap:5px; color:var(--text-tertiary); font-size:8.3px; }
.source-catalog-detail > span svg { color:var(--accent); }
.source-view-options { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
.source-view-options button { border:1px solid var(--border-default); background:var(--bg-0); border-radius:7px; padding:6px 3px; display:flex; justify-content:center; align-items:center; gap:4px; font-size:9px; }
.panel-section-label { display:flex; align-items:baseline; justify-content:space-between; margin:14px 2px 7px; gap:8px; }
.panel-section-label span { color:var(--text-secondary); font-size:9px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; }
.panel-section-label small { color:var(--text-muted); font-size:8px; }
.source-panel-state { border:1px dashed var(--border-default); border-radius:9px; padding:11px; margin:0 0 8px; display:flex; align-items:flex-start; gap:8px; color:var(--accent); }
.source-panel-state > div { display:grid; gap:3px; }
.source-panel-state strong { color:var(--text-primary); font-size:10px; }
.source-panel-state small { color:var(--text-tertiary); font-size:9px; line-height:1.4; overflow-wrap:anywhere; }
.source-panel-state.error { color:#b91c1c; border-color:color-mix(in srgb,#dc2626 34%,var(--border-default)); background:color-mix(in srgb,#dc2626 6%,var(--bg-0)); }
.source-panel-state.compact { padding:9px; }
.used-source-list { display:grid; gap:5px; }
.used-source-list > div { border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:9px; padding:7px; display:flex; align-items:center; gap:8px; }
.used-source-list > div > span { width:29px; height:29px; border-radius:8px; flex:none; display:grid; place-items:center; color:#15803d; background:color-mix(in srgb,#16a34a 9%,var(--bg-0)); }
.used-source-list > div > span.review_required, .used-source-list > div > span.draft_ready { color:#a16207; background:color-mix(in srgb,#d97706 9%,var(--bg-0)); }
.used-source-list p, .source-review-lane p { min-width:0; margin:0; display:grid; gap:2px; }
.used-source-list strong { font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.used-source-list small, .source-review-lane small { color:var(--text-tertiary); font-size:8.5px; line-height:1.4; }
.source-review-lane { margin:8px 0 13px; padding:8px; border:1px solid color-mix(in srgb,#d97706 25%,var(--border-default)); border-radius:9px; background:color-mix(in srgb,#d97706 6%,var(--bg-0)); color:#a16207; display:flex; align-items:flex-start; gap:7px; }
.source-review-lane strong { color:var(--text-primary); font-size:9.5px; }
.content-quick-add { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
.content-quick-add button { border:1px solid var(--border-subtle); background:transparent; border-radius:9px; padding:8px; display:flex; align-items:center; gap:8px; text-align:left; }
.content-quick-add button:hover { background:var(--bg-2); }
.content-quick-add button > span { flex:1; display:grid; gap:2px; }
.content-quick-add strong { font-size:10.5px; }
.content-quick-add small { color:var(--text-tertiary); font-size:8.5px; }
.content-quick-add button > svg:first-child { display:none; }
.content-quick-add button > svg:last-child { color:var(--accent); flex:none; }
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
.studio-filter > span, .studio-filter > label { color:var(--text-tertiary); font-size:8px; font-weight:750; }
.studio-filter input, .studio-filter select { min-width:100px; border:0; outline:0; background:transparent; padding:0; font-size:10px; }
.studio-filter > small { color:var(--text-muted); font-size:7.5px; line-height:1.2; }
.studio-filter.searchable { min-width:190px; position:relative; }
.studio-filter-combobox { display:flex; align-items:center; gap:5px; color:var(--text-tertiary); font-size:10px; font-weight:500; }
.studio-filter-combobox input { min-width:0; flex:1; color:var(--text-primary); }
.studio-filter-combobox input::-webkit-search-cancel-button { cursor:pointer; }
.studio-filter-combobox svg:last-child { margin-left:auto; flex:none; }
.studio-filter[aria-busy="true"] { border-color:color-mix(in srgb,var(--accent) 45%,var(--border-default)); }
.studio-filter.range { grid-template-columns:1fr auto 1fr; align-items:end; }
.studio-filter.range > span { grid-column:1/-1; }
.studio-filter.range input { min-width:112px; }
.studio-filter.range i { align-self:center; color:var(--text-muted); font-style:normal; }
.studio-filter.range > small { grid-column:1/-1; }
.studio-filter.empty { border-color:color-mix(in srgb,#d97706 42%,var(--border-default)); background:color-mix(in srgb,#d97706 5%,var(--bg-0)); }
.studio-filter.empty > small { color:#a16207; }
.studio-filter.boolean { display:flex; align-items:center; gap:6px; }
.studio-filter.boolean input { min-width:0; }
.studio-filter.boolean span { font-size:10px; color:var(--text-secondary); }
.studio-filter.dropdown { min-width:190px; position:relative; padding:0; display:block; }
.studio-filter.dropdown > summary { min-height:36px; padding:5px 8px; list-style:none; cursor:pointer; display:flex; align-items:center; gap:7px; }
.studio-filter.dropdown > summary::-webkit-details-marker { display:none; }
.studio-filter.dropdown > summary > span { min-width:0; display:grid; flex:1; gap:1px; }
.studio-filter.dropdown > summary small { color:var(--text-tertiary); font-size:8px; font-weight:750; }
.studio-filter.dropdown > summary strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-primary); font-size:10px; font-weight:600; }
.studio-filter.dropdown > summary > svg { color:var(--text-tertiary); transition:transform .14s ease; }
.studio-filter.dropdown[open] > summary > svg { transform:rotate(180deg); }
.studio-filter-menu { position:absolute; z-index:20; top:calc(100% + 5px); left:0; width:max(220px,100%); max-width:320px; padding:7px; border:1px solid var(--border-default); border-radius:9px; background:var(--bg-0); box-shadow:0 12px 28px color-mix(in srgb,var(--text-primary) 16%,transparent); display:grid; gap:5px; }
.studio-filter-menu > label { min-height:31px; border:1px solid var(--border-default); border-radius:7px; padding:0 7px; display:flex; align-items:center; gap:6px; color:var(--text-tertiary); }
.studio-filter-menu > label:focus-within { border-color:var(--accent); }
.studio-filter-menu > label input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:var(--text-primary); font-size:9px; }
.studio-filter-menu > button, .studio-filter-menu > div > button { width:100%; min-height:28px; border:0; border-radius:6px; padding:5px 7px; background:transparent; color:var(--text-secondary); display:flex; align-items:center; gap:6px; text-align:left; font-size:9px; }
.studio-filter-menu > button:hover, .studio-filter-menu > div > button:hover, .studio-filter-menu > div > button.on { background:var(--accent-dim); color:var(--text-primary); }
.studio-filter-menu > div { max-height:190px; overflow:auto; display:grid; gap:2px; }
.studio-filter-menu > div > button > span:not(.filter-option-check) { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-option-check { width:14px; height:14px; flex:none; border:1px solid var(--border-default); border-radius:4px; display:grid; place-items:center; color:var(--accent-fg); background:var(--bg-0); }
.studio-filter-menu > div > button.on .filter-option-check { border-color:var(--accent); background:var(--accent); }
.studio-filter-menu > small { padding:7px; color:var(--text-muted); font-size:8px; }
.studio-filter-menu footer { border-top:1px solid var(--border-subtle); padding:5px 3px 0; color:var(--text-muted); font-size:7.5px; }
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
.preview-loading-mark, .preview-idle-mark { width:34px; height:34px; border-radius:10px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.preview-state.loading .preview-loading-mark { animation:studio-loading-pulse 1.4s ease-in-out infinite; }
.preview-state.idle { min-height:130px; }
.empty-canvas { grid-column:1/-1; min-height:330px; border:1px dashed var(--border-strong); border-radius:12px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:30px; }
.empty-canvas > span { width:46px; height:46px; border-radius:13px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; }
.empty-canvas strong { margin-top:14px; }
.empty-canvas p { color:var(--text-tertiary); font-size:11px; max-width:320px; }
.empty-canvas button { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); padding:8px 12px; font-size:11px; font-weight:700; }
.studio-error { border:1px solid color-mix(in srgb,#dc2626 35%,var(--border-default)); background:color-mix(in srgb,#dc2626 8%,var(--bg-0)); color:#b91c1c; border-radius:9px; padding:10px 12px; font-size:11px; }
.studio-error.floating { position:sticky; top:0; z-index:4; margin:0 auto 10px; max-width:800px; display:flex; justify-content:space-between; }
.studio-error button { border:0; background:transparent; color:inherit; }

.studio-right { grid-column:3; grid-row:2; min-width:0; border-left:1px solid var(--border-subtle); overflow-y:auto; overflow-x:hidden; }
.studio-right > header { height:46px; border-bottom:1px solid var(--border-subtle); padding:0 12px; display:flex; align-items:center; justify-content:space-between; }
.studio-right > header > div { display:flex; align-items:center; gap:7px; font-size:11px; }
.inspector-body { min-width:0; max-width:100%; box-sizing:border-box; padding:14px; display:grid; gap:16px; }
.inspector-body section, .inspector-body section > *, .field-mapping > div, .format-grid > div, .frame-facts > div, .data-trust > div { min-width:0; max-width:100%; box-sizing:border-box; }
.inspector-body section { display:grid; gap:7px; }
.inspector-body p, .inspector-body span, .inspector-body strong, .inspector-body small, .field-help, .inspector-id { min-width:0; overflow-wrap:anywhere; word-break:break-word; }
.field-help { color:var(--text-tertiary); font-size:9px; line-height:1.45; }
.review-action { border:1px solid var(--accent); background:var(--accent-dim); color:var(--accent); border-radius:8px; padding:9px; display:flex; align-items:center; justify-content:center; gap:6px; font-size:10px; font-weight:750; }
.review-action:disabled { border-color:var(--border-default); background:var(--bg-2); color:var(--text-muted); cursor:default; }
.review-task-list > div { border:1px solid var(--border-subtle); border-radius:8px; padding:8px; display:grid; gap:7px; }
.review-task-list span { color:var(--text-secondary); font-size:9px; line-height:1.4; }
.review-task-list button { justify-self:start; border:0; background:transparent; color:var(--accent); padding:0; display:flex; gap:4px; align-items:center; font-size:9px; font-weight:750; }
.inspector-body label { color:var(--text-tertiary); font-size:9px; text-transform:uppercase; letter-spacing:.09em; font-weight:800; }
.inspector-body input, .inspector-body textarea, .inspector-body select, .inspector-body button { min-width:0; max-width:100%; box-sizing:border-box; }
.inspector-body input, .inspector-body textarea, .inspector-body select { width:100%; border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 10px; outline:none; font-size:11px; }
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

.studio-ai-plan { width:min(920px,100%); margin:0 auto; box-sizing:border-box; border:1px solid var(--border-default); background:var(--bg-0); border-radius:18px; box-shadow:0 18px 52px color-mix(in srgb,var(--text-primary) 9%,transparent); overflow:hidden; }
.proposal-source-picker { isolation:isolate; }
.studio-ai-plan > header { padding:22px 24px; display:flex; align-items:flex-start; gap:12px; border-bottom:1px solid var(--border-subtle); }
.studio-ai-plan > header > span { width:38px; height:38px; flex:none; border-radius:11px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.studio-ai-plan > header > div { flex:1; min-width:0; display:grid; gap:4px; }
.studio-ai-plan > header small { color:var(--accent); font-size:8px; font-weight:800; letter-spacing:.1em; }
.studio-ai-plan > header h1 { margin:0; font-size:22px; letter-spacing:-.025em; }
.studio-ai-plan > header p { max-width:700px; margin:2px 0 0; color:var(--text-secondary); font-size:10.5px; line-height:1.5; }
.studio-ai-plan > header p strong { color:var(--text-primary); }
.studio-ai-plan > header > button { width:31px; height:31px; flex:none; border:0; border-radius:8px; display:grid; place-items:center; background:transparent; color:var(--text-tertiary); }
.studio-ai-plan > header > button:hover { background:var(--bg-2); color:var(--text-primary); }
.proposal-source-summary { display:flex; align-items:center; gap:7px; flex-wrap:wrap; padding:11px 24px; border-bottom:1px solid var(--border-subtle); background:var(--bg-1); }
.proposal-source-summary span { border:1px solid var(--border-subtle); background:var(--bg-0); border-radius:999px; padding:6px 9px; color:var(--text-tertiary); font-size:8.5px; }
.proposal-source-summary strong { color:var(--text-primary); }
.proposal-source-body { padding:18px 24px 22px; display:grid; gap:18px; }
.proposal-source-search { display:flex; align-items:center; gap:8px; border:1px solid var(--border-default); background:var(--bg-1); border-radius:10px; padding:0 11px; color:var(--text-tertiary); }
.proposal-source-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
.proposal-source-search input { width:100%; min-width:0; border:0; outline:0; background:transparent; padding:11px 0; font-size:10.5px; }
.proposal-source-group { display:grid; gap:8px; }
.proposal-source-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.proposal-source-heading > div { display:grid; gap:2px; }
.proposal-source-heading h2 { margin:0; font-size:12px; }
.proposal-source-heading p { margin:0; color:var(--text-tertiary); font-size:8.5px; }
.proposal-source-heading > strong { min-width:25px; height:25px; display:grid; place-items:center; border-radius:999px; color:var(--accent); background:var(--accent-dim); font-size:9px; }
.proposal-source-list, .proposal-catalog-list { display:grid; gap:6px; }
.proposal-source-row, .proposal-catalog-list > article { min-width:0; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:11px; padding:10px; display:grid; grid-template-columns:34px minmax(0,1fr) auto; align-items:center; gap:10px; }
.proposal-source-row.selected { border-color:color-mix(in srgb,#16a34a 25%,var(--border-default)); background:color-mix(in srgb,#16a34a 4%,var(--bg-1)); }
.proposal-source-trust, .proposal-catalog-list > article > span { width:34px; height:34px; border-radius:9px; display:grid; place-items:center; color:#15803d; background:color-mix(in srgb,#16a34a 9%,var(--bg-0)); }
.proposal-source-trust.review_required, .proposal-source-trust.draft_ready, .proposal-catalog-list > article > span.review_required { color:#a16207; background:color-mix(in srgb,#d97706 9%,var(--bg-0)); }
.proposal-source-row > div, .proposal-catalog-list > article > div { min-width:0; display:grid; gap:2px; }
.proposal-source-row strong, .proposal-catalog-list strong { font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.proposal-source-row small, .proposal-catalog-list small { color:var(--text-tertiary); font-size:8.5px; }
.proposal-source-row p, .proposal-catalog-list p { margin:1px 0 0; color:var(--text-secondary); font-size:8.5px; line-height:1.4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.proposal-source-row > button, .proposal-catalog-list > article > button { border:1px solid var(--border-default); background:var(--bg-0); border-radius:8px; padding:7px 9px; display:flex; align-items:center; gap:5px; color:var(--accent); font-size:8.5px; font-weight:800; }
.proposal-source-row > button, .proposal-catalog-list > article > button { max-width:190px; white-space:normal; line-height:1.25; text-align:center; justify-content:center; }
.proposal-source-row > button.remove { color:var(--text-secondary); }
.proposal-source-row > button:hover, .proposal-catalog-list > article > button:hover { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.proposal-source-row > button:disabled, .proposal-catalog-list > article > button:disabled { opacity:.45; cursor:default; }
.proposal-source-empty { border:1px dashed var(--border-default); border-radius:11px; padding:14px; display:flex; align-items:center; gap:10px; color:var(--accent); }
.proposal-source-empty > div { display:grid; gap:2px; }
.proposal-source-empty strong { color:var(--text-primary); font-size:10px; }
.proposal-source-empty p { margin:0; color:var(--text-tertiary); font-size:8.5px; }
.studio-ai-review-lane { border:1px dashed color-mix(in srgb,#d97706 32%,var(--border-default)); border-radius:9px; padding:9px; display:flex; align-items:flex-start; gap:8px; color:#a16207; }
.studio-ai-review-lane p { margin:0; display:grid; gap:2px; }
.studio-ai-review-lane strong { color:var(--text-primary); font-size:9px; }
.studio-ai-review-lane small { color:var(--text-tertiary); font-size:8.5px; line-height:1.4; }
.studio-ai-plan-empty { margin:0; color:var(--text-tertiary); font-size:9px; line-height:1.45; padding:12px; border:1px dashed var(--border-default); border-radius:9px; }
.studio-ai-questions { border:1px solid color-mix(in srgb,#d97706 28%,var(--border-default)); background:color-mix(in srgb,#d97706 6%,var(--bg-0)); border-radius:10px; padding:11px; display:grid; gap:8px; }
.studio-ai-questions > header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.studio-ai-questions > header strong { font-size:10px; }
.studio-ai-questions > header small { color:#a16207; font-size:8.5px; }
.studio-ai-questions > p { margin:0; color:var(--text-secondary); font-size:9px; line-height:1.45; }
.studio-ai-questions button { justify-self:start; border:1px solid var(--accent); color:var(--accent); background:var(--accent-dim); border-radius:8px; padding:7px 9px; font-size:8.5px; font-weight:750; }
.studio-ai-plan > footer { position:sticky; bottom:0; border-top:1px solid var(--border-subtle); background:var(--bg-0); padding:14px 24px; display:flex; justify-content:flex-end; gap:8px; }
.studio-ai-plan > footer > span { margin-right:auto; align-self:center; color:var(--text-tertiary); font-size:8.5px; }
.studio-ai-plan > footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:9px; padding:9px 12px; font-size:9.5px; font-weight:750; }
.studio-ai-plan > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); display:flex; align-items:center; gap:6px; }
.studio-ai-plan > footer button:disabled { opacity:.45; cursor:default; }
.studio-copilot-panel { top:58px !important; bottom:0 !important; height:auto !important; }
.studio-copilot-loading { padding:18px; color:var(--text-tertiary); font-size:11px; }

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
.studio-readiness-card { width:min(680px,100%); max-height:calc(100vh - 48px); overflow:hidden; display:flex; flex-direction:column; border:1px solid var(--border-default); background:var(--bg-0); border-radius:18px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); }
.studio-readiness-card > header { padding:19px 20px; display:flex; align-items:flex-start; gap:11px; border-bottom:1px solid var(--border-subtle); }
.studio-readiness-card > header > span { width:38px; height:38px; flex:none; border-radius:11px; display:grid; place-items:center; color:#a16207; background:color-mix(in srgb,#d97706 9%,var(--bg-0)); }
.studio-readiness-card > header > span.ready { color:#15803d; background:color-mix(in srgb,#16a34a 9%,var(--bg-0)); }
.studio-readiness-card > header > div { flex:1; min-width:0; display:grid; gap:4px; }
.studio-readiness-card h2 { margin:0; font-size:18px; letter-spacing:-.02em; }
.studio-readiness-card > header p { margin:0; color:var(--text-secondary); font-size:10.5px; line-height:1.5; }
.studio-readiness-card > header .icon { width:32px; height:32px; flex:none; }
.readiness-body { min-height:0; overflow:auto; padding:14px 20px; display:grid; gap:8px; }
.readiness-item { border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:11px; padding:12px; display:flex; align-items:flex-start; gap:10px; }
.readiness-item.warning { border-color:color-mix(in srgb,#d97706 28%,var(--border-default)); background:color-mix(in srgb,#d97706 5%,var(--bg-0)); }
.readiness-item .step-mark { width:31px; height:31px; flex:none; display:grid; place-items:center; border-radius:8px; color:var(--accent); background:var(--accent-dim); }
.readiness-item.warning .step-mark { color:#a16207; background:color-mix(in srgb,#d97706 10%,var(--bg-0)); }
.readiness-item > div { min-width:0; flex:1; display:grid; gap:4px; }
.readiness-item strong { font-size:11px; }
.readiness-item p { margin:0; color:var(--text-secondary); font-size:10.5px; line-height:1.45; overflow-wrap:anywhere; }
.readiness-item small { color:var(--text-tertiary); font-size:9px; line-height:1.4; }
.readiness-actions, .readiness-choices { margin-top:5px; display:flex; gap:6px; flex-wrap:wrap; }
.readiness-actions button, .readiness-choices button { border:1px solid var(--border-default); background:var(--bg-0); border-radius:7px; padding:7px 9px; display:inline-flex; align-items:center; gap:5px; color:var(--text-secondary); font-size:9px; font-weight:750; }
.readiness-actions button.primary { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.readiness-actions button:disabled, .readiness-choices button:disabled { opacity:.5; cursor:default; }
.readiness-ready { border:1px solid color-mix(in srgb,#16a34a 25%,var(--border-default)); background:color-mix(in srgb,#16a34a 6%,var(--bg-0)); border-radius:11px; padding:14px; display:flex; align-items:flex-start; gap:9px; color:#15803d; }
.readiness-ready > div { display:grid; gap:3px; }
.readiness-ready strong { color:var(--text-primary); font-size:11px; }
.readiness-ready span { color:var(--text-secondary); font-size:9.5px; line-height:1.45; }
.studio-readiness-card > footer { padding:14px 20px; border-top:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:flex-end; gap:8px; }
.studio-readiness-card > footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 12px; font-size:10px; font-weight:750; }
.studio-readiness-card > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.studio-readiness-card > footer button:disabled { opacity:.5; cursor:default; }
.readiness-footer-hint { flex:1; color:var(--text-tertiary); font-size:9.5px; text-align:right; }
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
  .studio-actions .copilot span { display:none; }
  .studio-actions .copilot { width:34px; height:34px; padding:0; justify-content:center; }
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
  .studio-actions .breakpoints, .studio-actions > .icon { display:none; }
  .studio-actions > .overflow-button { display:flex; }
  .studio-actions { padding-right:8px; gap:5px; }
  .studio-actions .preview, .studio-actions .publish { width:36px; height:34px; padding:0; justify-content:center; }
  .studio-actions .preview span, .studio-actions .publish span, .studio-actions .publish small { display:none; }
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
  .proposal-focus .studio-topbar { grid-template-columns:58px minmax(0,1fr); }
  .proposal-focus .proposal-focus-status { display:none; }
  .proposal-focus-title { justify-items:start; padding-left:8px; }
  .proposal-focus .studio-workspace { padding:10px; }
  .studio-ai-plan { border-radius:14px; }
  .studio-ai-plan > header, .proposal-source-body, .studio-ai-plan > footer { padding-left:14px; padding-right:14px; }
  .studio-ai-plan > header h1 { font-size:18px; }
  .proposal-source-summary { padding-left:14px; padding-right:14px; }
  .proposal-source-row, .proposal-catalog-list > article { grid-template-columns:32px minmax(0,1fr); }
  .proposal-source-row > button, .proposal-catalog-list > article > button { grid-column:2; justify-self:start; }
  .studio-ai-plan > footer { display:grid; grid-template-columns:1fr 1fr; }
  .studio-ai-plan > footer > span { grid-column:1/-1; }
  .studio-ai-plan > footer button.primary { justify-content:center; }
  .proposal-scrim { padding:10px; align-items:flex-end; }
  .studio-readiness-card { max-height:calc(100vh - 20px); border-radius:15px 15px 0 0; }
  .studio-readiness-card > header, .readiness-body, .studio-readiness-card > footer { padding-left:14px; padding-right:14px; }
  .readiness-item { padding:10px; }
  .studio-readiness-card > footer { display:grid; grid-template-columns:1fr 1fr; }
}
@media (prefers-reduced-motion:reduce) { .studio-canvas-frame, .policy-toggle i:after, .studio-review-toggle i:after, .dql-studio-v2-loading .loading-mark, .preview-state.loading .preview-loading-mark { transition:none; animation:none; } }
`;
