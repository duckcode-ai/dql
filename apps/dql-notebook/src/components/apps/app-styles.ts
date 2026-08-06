/**
 * Styles for the Apps surface.
 *
 * Extracted from `AppsView.tsx`, where this template literal was roughly half
 * the file and made the components around it hard to find or review.
 */
import { AI_SIDE_PANEL_EXPANDED_WIDTH } from '../agent/AiSidePanel';

export const APP_STYLES = `
.dql-apps-waterline {
  --dql-app-canvas: var(--color-bg-primary, #f7f8fb);
  --dql-app-surface: var(--color-bg-card, #ffffff);
  --dql-app-surface-muted: var(--color-bg-secondary, #f8fafc);
  --dql-app-control: var(--color-bg-sunken, #f4f6f9);
  --dql-app-line: var(--color-border-subtle, rgba(15, 23, 42, 0.10));
  --dql-app-line-2: var(--color-border-primary, rgba(15, 23, 42, 0.16));
  --dql-app-ink: var(--color-text-primary, #0f172a);
  --dql-app-muted: var(--color-text-secondary, #64748b);
  --dql-app-faint: var(--color-text-tertiary, #94a3b8);
  --dql-app-accent: var(--color-accent-blue, #2563eb);
  --dql-app-accent-soft: var(--accent-dim, rgba(37, 99, 235, 0.10));
  --dql-app-deep: #111827;
  --dql-app-green: var(--color-status-success, #16a34a);
  --dql-app-green-soft: var(--status-success-bg, rgba(22, 163, 74, 0.08));
  --dql-app-orange: var(--color-status-warning, #ca8a04);
  --dql-app-orange-soft: var(--status-warning-bg, rgba(202, 138, 4, 0.10));
  --dql-app-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 10px 28px rgba(15, 23, 42, 0.06);
  --surface: var(--dql-app-surface);
  --surface-hover: var(--dql-app-control);
  --border-color: var(--dql-app-line);
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--dql-app-canvas);
  color: var(--dql-app-ink);
  font-family: var(--font-ui);
  font-size: 14px;
  line-height: 1.45;
  text-rendering: geometricPrecision;
}

.dql-apps-waterline * {
  letter-spacing: 0;
}

/* Per-theme palettes come straight from the Luna tokens the base block maps
   (tokens.css under [data-theme]) — the redesign handoff palette IS the Paper
   token set, so no per-theme hex overrides remain here. Obsidian only mutes
   card shadows. */
.dql-apps-theme-obsidian {
  --dql-app-deep: #05070b;
  --dql-app-shadow: none;
}

.dql-apps-wrap {
  width: min(880px, calc(100% - 48px));
  margin: 0 auto;
  padding: 28px 0 40px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dql-apps-createhead h1 {
  margin: 0;
  font-size: 18px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.dql-apps-createhead p {
  margin: 3px 0 0;
  color: var(--dql-app-faint);
  font-size: 12.5px;
  line-height: 1.55;
  max-width: 720px;
}

/* Prototype composer card (library) */
.dql-apps-composer {
  background: var(--dql-app-surface);
  border: 1px solid var(--dql-app-line-2);
  border-radius: 14px;
  box-shadow: 0 1px 2px rgba(26, 26, 26, 0.03), 0 6px 22px rgba(26, 26, 26, 0.05);
  display: flex;
  flex-direction: column;
}
.dql-apps-targets {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 10px 10px 2px;
}
.dql-apps-targets button {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 2px 7px;
  border: 1px solid var(--dql-app-line);
  border-radius: 9px;
  background: var(--dql-app-control);
  color: var(--dql-app-muted);
  padding: 8px 10px;
  text-align: left;
  font: 750 11.5px var(--font-ui);
  cursor: pointer;
}
.dql-apps-targets button.on {
  border-color: var(--dql-app-accent);
  color: var(--dql-app-ink);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dql-app-accent) 18%, transparent);
}
.dql-apps-targets button small {
  grid-column: 2;
  color: var(--dql-app-faint);
  font-size: 10px;
  font-weight: 500;
}
.dql-apps-composer textarea {
  border: 0; background: transparent; resize: none; outline: none;
  padding: 13px 15px 4px;
  font-size: 13.5px; line-height: 1.5;
  color: var(--dql-app-ink); font-family: inherit;
}
.dql-apps-composer-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px 10px 12px; }
.dql-apps-composer-row > i { flex: 1; }
.dql-apps-explore-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--dql-app-muted);
  font-size: 10.5px;
  cursor: pointer;
}
.dql-apps-explore-toggle input { accent-color: var(--dql-app-accent); }
.dql-apps-composer-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 9px; border-radius: 8px;
  border: 1px solid var(--dql-app-line);
  background: var(--dql-app-canvas);
  font-size: 11.5px; color: var(--dql-app-muted); white-space: nowrap;
}
.dql-apps-composer-chip svg { color: var(--dql-app-green); }
.dql-apps-composer-blank {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 11px;
  border-radius: 8px; border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface); color: var(--dql-app-muted);
  font-size: 11.5px; font-weight: 600; cursor: pointer; font-family: inherit;
}
.dql-apps-composer-blank:hover { background: var(--dql-app-surface-muted); }
.dql-apps-composer-send {
  width: 34px; height: 34px; border-radius: 10px; border: 0;
  background: var(--dql-app-accent); color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; box-shadow: 0 1px 5px rgba(107, 93, 211, 0.3);
}
.dql-apps-composer-send:hover { filter: brightness(0.95); }
.dql-apps-composer-send:disabled { opacity: 0.5; cursor: default; box-shadow: none; }
.dql-apps-try { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dql-apps-try > span { font-size: 10.5px; color: var(--dql-app-faint); }
.dql-apps-try button {
  border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  border-radius: 999px; padding: 3.5px 11px;
  font-size: 11px; font-weight: 550; cursor: pointer; font-family: inherit;
}
.dql-apps-try button:hover { border-color: var(--dql-app-accent); color: var(--dql-app-accent); background: var(--dql-app-accent-soft); }

.dql-apps-btn {
  height: 32px;
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font: 750 12px var(--font-ui);
  cursor: pointer;
  white-space: nowrap;
}

.dql-apps-btn:disabled { opacity: 0.62; cursor: not-allowed; }
.dql-apps-btn-primary { background: var(--dql-app-accent); color: #fff; }
.dql-apps-btn-line { background: var(--dql-app-surface); border-color: var(--dql-app-line-2); color: var(--dql-app-ink); }
.dql-apps-btn-icon { width: 32px; padding: 0; flex: none; }
.dql-apps-btn-icon:hover,
.dql-apps-btn-icon.on { color: var(--dql-app-accent); border-color: rgba(79, 99, 215, 0.34); background: var(--dql-app-accent-soft); }
.dql-apps-btn-dark { width: 100%; background: var(--dql-app-deep); border-color: #1f2937; color: #fff; margin-top: 12px; }

.dql-apps-ai-entry {
  margin-top: 18px;
  border: 1px solid rgba(79, 99, 215, 0.26);
  border-radius: 12px;
  background: var(--dql-app-surface);
  box-shadow: var(--dql-app-shadow);
  padding: 16px;
  display: grid;
  gap: 12px;
}

.dql-apps-ai-entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dql-apps-ai-entry-head span,
.dql-apps-ai-entry-head b {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 850 11px var(--font-ui);
}

.dql-apps-ai-entry-head span {
  color: var(--dql-app-accent);
}

.dql-apps-ai-entry-head b {
  color: var(--dql-app-green);
}

.dql-apps-ai-entry-box {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 12px;
}

.dql-apps-ai-entry-box textarea {
  width: 100%;
  min-height: 112px;
  resize: vertical;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 10px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  outline: 0;
  padding: 13px 14px;
  font: 540 15px/1.5 var(--font-ui);
}

.dql-apps-ai-entry-box textarea:focus {
  border-color: rgba(79, 99, 215, 0.52);
  box-shadow: 0 0 0 3px rgba(79, 99, 215, 0.1);
}

.dql-apps-ai-entry-box button {
  height: 46px;
  border: 0;
  border-radius: 10px;
  background: var(--dql-app-accent);
  color: #fff;
  padding: 0 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font: 800 12.5px var(--font-ui);
  cursor: pointer;
  box-shadow: 0 12px 26px rgba(79, 99, 215, 0.2);
}

.dql-apps-ai-entry-box button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dql-apps-ai-entry-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.dql-apps-ai-entry-foot > div {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dql-apps-ai-entry-foot button {
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 6px 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: 750 11.5px var(--font-ui);
  cursor: pointer;
}

.dql-apps-ai-entry-foot button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.32);
  background: var(--dql-app-accent-soft);
}

.dql-apps-ai-entry-secondary {
  flex: none;
  color: var(--dql-app-ink) !important;
}

.dql-apps-sectionhead {
  margin: 30px 0 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--dql-app-muted);
}

.dql-apps-sectionhead span,
.dql-app-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-apps-sectionhead i { flex: 1; border-top: 1px solid var(--dql-app-line); }
.dql-apps-sectionhead b { font-family: var(--font-mono); font-size: 10px; color: var(--dql-app-faint); }

.dql-apps-libbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.dql-apps-filter-tabs {
  display: flex;
  gap: 3px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-control);
  padding: 4px;
  flex-wrap: wrap;
}

.dql-apps-filter-tabs button {
  border: 0;
  background: transparent;
  border-radius: 999px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--dql-app-muted);
  font: 800 12px var(--font-ui);
}

.dql-apps-filter-tabs button.on { background: var(--dql-app-surface); color: var(--dql-app-ink); box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08); }
.dql-apps-filter-tabs span { margin-left: 5px; color: var(--dql-app-accent); font-family: var(--font-mono); font-size: 10px; }

.dql-apps-search {
  flex: 1;
  min-width: 220px;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--dql-app-surface);
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  padding: 0 12px;
  color: var(--dql-app-faint);
}

.dql-apps-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dql-app-ink);
  font: 13px var(--font-ui);
}

.dql-apps-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.dql-app-card {
  min-width: 0;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  overflow: hidden;
  box-shadow: var(--dql-app-shadow);
}

.dql-app-card-body {
  padding: 16px;
  cursor: pointer;
}

.dql-app-card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 9px;
}

.dql-app-star {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  color: var(--dql-app-faint);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.dql-app-star.on { color: var(--dql-app-accent); background: var(--dql-app-accent-soft); border-color: rgba(37, 99, 235, 0.35); }
.dql-app-card h3 { margin: 13px 0 0; font-size: 17px; line-height: 1.2; }
.dql-app-card p { min-height: 54px; margin: 7px 0 0; color: var(--dql-app-muted); font-size: 12px; line-height: 1.5; }

.dql-app-card-mini {
  margin-top: 13px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.dql-app-card-mini span {
  border-radius: 6px;
  background: var(--dql-app-control);
  padding: 7px 9px;
}

.dql-app-card-mini small {
  display: block;
  font-family: var(--font-mono);
  font-size: 7.5px;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--dql-app-muted);
}

.dql-app-card-mini b { display: block; margin-top: 1px; font-size: 15px; }

.dql-app-card-signals {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  color: var(--dql-app-muted);
  font: 700 10px var(--font-mono);
}

.dql-app-card-signals span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 4px 8px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface-muted);
  white-space: nowrap;
}

.dql-app-card-depth {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--dql-app-muted);
}

.dql-app-card-depth span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-card-depth button { border: 0; background: transparent; color: var(--dql-app-accent); cursor: pointer; font: 800 11px var(--font-ui); }
.dql-app-card-act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none !important;
  min-height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dql-app-line) !important;
  border-radius: 6px;
  background: var(--dql-app-surface) !important;
  color: var(--dql-app-muted) !important;
  font: 650 11px var(--font-ui) !important;
  transition: border-color 0.12s ease, color 0.12s ease;
}
.dql-app-card-act:hover {
  border-color: var(--dql-app-accent) !important;
  color: var(--dql-app-accent) !important;
}
.dql-app-card-act.danger:hover {
  border-color: var(--status-error-border) !important;
  color: var(--status-error) !important;
}

.dql-app-block-cite i,
.dql-app-plan-item > i {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--dql-app-green);
  flex: none;
}

.dql-app-block-cite i.draft,
.dql-app-plan-item > i.draft { background: var(--dql-app-orange); }

.dql-app-seal {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 999px;
  min-height: 22px;
  padding: 2px 9px;
  width: fit-content;
  border: 1px solid rgba(22, 163, 74, 0.26);
  background: var(--dql-app-green-soft);
  color: var(--dql-app-green);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-seal::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
}

.dql-app-seal.draft { border-color: rgba(202, 138, 4, 0.30); background: var(--dql-app-orange-soft); color: var(--dql-app-orange); }
.dql-app-seal.agentic { border-color: rgba(37, 99, 235, 0.32); background: var(--dql-app-accent-soft); color: var(--dql-app-accent); }

.dql-app-create-shell,
.dql-app-workspace {
  height: 100%;
  min-height: 0;
  display: grid;
}

.dql-app-create-shell { grid-template-rows: auto 1fr; overflow: hidden; }
.dql-app-workspace { grid-template-rows: auto auto 1fr; }

.dql-app-buildbar,
.dql-app-view-topbar {
  min-height: 54px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 18px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  flex-wrap: wrap;
}

.dql-app-back {
  width: 30px;
  height: 30px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dql-app-muted);
  cursor: pointer;
  flex: none;
}

.dql-app-back:hover { color: var(--dql-app-ink); border-color: var(--dql-app-line-2); }

.dql-app-back-label {
  width: auto;
  min-width: 72px;
  padding: 0 11px 0 9px;
  gap: 6px;
  justify-content: flex-start;
  color: var(--dql-app-ink);
  font: 750 12px var(--font-ui);
}

.dql-app-back-label span {
  line-height: 1;
}

.dql-app-topbar-divider {
  width: 1px;
  height: 22px;
  background: var(--dql-app-line);
  flex: none;
}

.dql-app-topbar-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dql-app-filter-icon {
  display: inline-flex;
  align-items: center;
  color: var(--dql-app-faint);
}

.dql-app-name-input input {
  width: 240px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 8px;
  outline: 0;
  background: transparent;
  color: var(--dql-app-ink);
  font: 800 16px var(--font-ui);
}

.dql-app-name-input input:focus { border-color: var(--dql-app-accent); background: var(--dql-app-control); }
.dql-app-mode-seg {
  margin: 0 auto;
  display: flex;
  gap: 2px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-control);
  padding: 3px;
}

.dql-app-mode-seg button {
  min-width: 78px;
  border: 0;
  background: transparent;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  padding: 6px 12px;
  color: var(--dql-app-muted);
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-mode-seg button.on { background: var(--dql-app-deep); color: #fff; }

.dql-app-customize-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 14px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-customize-btn:hover {
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
}

.dql-app-customize-btn.on {
  border-color: var(--dql-app-deep);
  background: var(--dql-app-deep);
  color: #fff;
}
.dql-app-build-actions,
.dql-app-view-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.dql-app-view-actions { position: relative; }

.dql-app-share-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 20;
  width: min(340px, 80vw);
  border: 1px solid var(--dql-app-line-2);
  border-radius: 8px;
  background: var(--dql-app-surface);
  box-shadow: var(--dql-app-shadow);
  padding: 10px;
  display: grid;
  gap: 7px;
}

.dql-app-share-popover b {
  color: var(--dql-app-ink);
  font: 850 12px var(--font-ui);
}

.dql-app-share-popover textarea {
  width: 100%;
  min-height: 92px;
  resize: none;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  padding: 8px;
  font: 11px/1.45 var(--font-mono);
  box-sizing: border-box;
}

.dql-app-promote-popover {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  z-index: 21;
  max-width: min(360px, 80vw);
  border: 1px solid rgba(22, 163, 74, 0.28);
  border-radius: 8px;
  background: var(--dql-app-green-soft);
  color: var(--dql-app-ink);
  box-shadow: var(--dql-app-shadow);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.4;
}

.dql-app-promote-popover.error {
  border-color: rgba(202, 138, 4, 0.28);
  background: var(--dql-app-orange-soft);
}

.dql-app-persona {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  padding: 3px 9px 3px 4px;
  color: var(--dql-app-muted);
  font-size: 12px;
}

.dql-app-persona b {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dql-app-accent);
  color: #fff;
  font-size: 9px;
}

.dql-app-create-workspace {
  min-height: 0;
  display: grid;
  grid-template-columns: 380px minmax(420px, 1fr) 300px;
}

.dql-app-create-workspace.classic { grid-template-columns: 286px minmax(420px, 1fr) 320px; }
.dql-app-create-workspace.clean {
  display: block;
  min-height: calc(100vh - 56px);
  overflow: auto;
  padding: 26px;
  background: var(--dql-app-canvas);
}

.dql-app-ai-start {
  max-width: 1260px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
  gap: 18px;
  align-items: start;
}

.dql-app-ai-start-main {
  min-width: 0;
  display: grid;
  gap: 14px;
}

.dql-app-ai-start-copy h1 {
  margin: 0 0 7px;
  color: var(--dql-app-ink);
  font-size: clamp(30px, 4vw, 52px);
  line-height: 0.98;
  letter-spacing: 0;
}

.dql-app-ai-start-copy p {
  margin: 0;
  max-width: 650px;
  color: var(--dql-app-muted);
  font-size: 14px;
  line-height: 1.55;
}

.dql-app-ai-start-card {
  position: relative;
  border: 1px solid rgba(79, 99, 215, 0.32);
  border-radius: 12px;
  background: var(--dql-app-surface);
  box-shadow: var(--dql-app-shadow);
  padding: 18px 76px 18px 18px;
}

.dql-app-ai-start-card textarea {
  width: 100%;
  min-height: 124px;
  resize: vertical;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dql-app-ink);
  padding: 0;
  font: 520 18px/1.45 var(--font-ui);
}

.dql-app-ai-start-send {
  position: absolute;
  right: 18px;
  bottom: 18px;
  width: 46px;
  height: 46px;
  border: 0;
  border-radius: 999px;
  background: var(--dql-app-accent);
  color: white;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 14px 30px rgba(79, 99, 215, 0.24);
}

.dql-app-ai-start-send:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dql-app-ai-start-examples {
  padding-left: 2px;
}

.dql-app-ai-start-advanced {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  padding: 0 12px;
}

.dql-app-ai-start-advanced .dql-app-palette {
  max-height: 340px;
  margin: 0 0 12px;
}

.dql-app-ai-start-result {
  margin: 0;
}

.dql-app-ai-start-context {
  display: grid;
  gap: 12px;
}

.dql-app-ai-context-card {
  border: 1px solid var(--dql-app-line);
  border-radius: 10px;
  background: var(--dql-app-surface);
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.04);
  overflow: hidden;
}

.dql-app-ai-evidence-list {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.dql-app-ai-evidence-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 9px;
  align-items: start;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface-muted);
  padding: 10px;
}

.dql-app-ai-evidence-row > span:first-child {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--dql-app-green-soft);
  color: var(--dql-app-green);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dql-app-ai-evidence-row b {
  display: block;
  color: var(--dql-app-ink);
  font-size: 12px;
  line-height: 1.25;
}

.dql-app-ai-evidence-row small {
  display: block;
  margin-top: 3px;
  color: var(--dql-app-muted);
  font-size: 11px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dql-app-ai-filter-preview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 12px;
}

.dql-app-ai-filter-preview span {
  min-height: 70px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface-muted);
  padding: 10px;
}

.dql-app-ai-filter-preview small {
  display: block;
  color: var(--dql-app-faint);
  font: 800 9.5px var(--font-mono);
  text-transform: uppercase;
  margin-bottom: 8px;
}

.dql-app-ai-filter-preview b {
  color: var(--dql-app-accent);
  font-size: 18px;
  line-height: 1.1;
}

.dql-app-ai-gap-list {
  display: grid;
  gap: 8px;
  padding: 12px;
}

.dql-app-ai-gap-list span {
  display: flex;
  gap: 8px;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.4;
}

.dql-app-ai-gap-list svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--dql-app-orange);
}

.dql-app-ai-generated-section {
  max-width: 1260px;
  margin: 18px auto 0;
  display: grid;
  gap: 12px;
}

.dql-app-ai-generated-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
}

.dql-app-ai-generated-head h2 {
  margin: 0;
  color: var(--dql-app-ink);
  font-size: 20px;
}

.dql-app-ai-generated-head p {
  margin: 4px 0 0;
  color: var(--dql-app-muted);
  font-size: 12.5px;
}

.dql-app-ai-generated-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
  gap: 14px;
  align-items: start;
}

.dql-app-ai-plan-compact {
  border: 1px solid var(--dql-app-line);
  border-radius: 10px;
  background: var(--dql-app-surface);
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.04);
}

.dql-app-plan-list.compact {
  max-height: 520px;
}
.dql-app-panel {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
}

.dql-app-panel:last-child { border-right: 0; }
.dql-app-panel-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 15px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
}

.dql-app-panel-head span { font-weight: 850; font-size: 14px; }
.dql-app-panel-head b { margin-left: auto; color: var(--dql-app-faint); font: 500 10px var(--font-mono); text-transform: uppercase; letter-spacing: 0; }

.dql-app-agent-scroll,
.dql-app-plan-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.dql-app-agent-panel.ai-clean { background: var(--dql-app-surface); }
.dql-app-ai-brief {
  padding: 18px 16px 2px;
  display: grid;
  gap: 8px;
}

.dql-app-ai-brief > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dql-app-ink);
  font: 850 13px var(--font-ui);
}

.dql-app-ai-brief > span svg { color: var(--dql-app-accent); }
.dql-app-ai-brief p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.dql-app-ai-result {
  margin-top: 5px;
  border: 1px solid rgba(22, 163, 74, 0.26);
  border-radius: 7px;
  background: var(--dql-app-green-soft);
  color: var(--dql-app-ink);
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-ai-result small {
  display: block;
  margin-top: 3px;
  color: var(--dql-app-muted);
  font: 700 10px var(--font-mono);
}

.dql-app-composer {
  border-top: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  padding: 12px;
  display: grid;
  gap: 9px;
}

.dql-app-composer.ai-clean {
  border-top: 0;
  padding: 10px 16px 16px;
  gap: 9px;
}

.dql-app-suggestions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.dql-app-suggestions > span {
  color: var(--dql-app-faint);
  font: 750 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-suggestions button,
.dql-app-suggests button {
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--dql-app-muted);
  padding: 2px 0;
  cursor: pointer;
  font: 750 11.5px var(--font-ui);
}

.dql-app-suggestions button:hover,
.dql-app-suggests button:hover {
  color: var(--dql-app-accent);
}

.dql-app-composer textarea,
.dql-app-form-grid input,
.dql-app-select-label select,
.dql-app-modal input,
.dql-app-modal textarea {
  width: 100%;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  outline: 0;
  padding: 8px 10px;
  font: 12.5px var(--font-ui);
}
.dql-app-modal textarea { resize: vertical; min-height: 96px; line-height: 1.45; }

.dql-app-composer textarea { resize: vertical; min-height: 92px; line-height: 1.45; }
.dql-app-composer.ai-clean textarea {
  min-height: 130px;
  background: var(--dql-app-surface);
  border-color: var(--dql-app-line-2);
  border-radius: 10px;
  padding: 11px 12px;
  font-size: 13.5px;
}
.dql-app-form-grid.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dql-app-form-grid label,
.dql-app-select-label,
.dql-app-modal label {
  display: grid;
  gap: 5px;
  color: var(--dql-app-muted);
  font: 700 10px var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
}

.dql-app-ai-context {
  border-top: 1px solid var(--dql-app-line);
  border-bottom: 1px solid var(--dql-app-line);
  background: transparent;
}

.dql-app-ai-context summary {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  cursor: pointer;
  list-style: none;
}

.dql-app-ai-context summary::-webkit-details-marker { display: none; }

.dql-app-ai-context summary span {
  color: var(--dql-app-muted);
  font: 800 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-ai-context summary b {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dql-app-ink);
  font: 750 11px var(--font-ui);
}

.dql-app-ai-context summary svg {
  flex: 0 0 auto;
  color: var(--dql-app-faint);
  transition: transform 140ms ease;
}

.dql-app-ai-context[open] summary svg { transform: rotate(180deg); }

.dql-app-ai-context-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  padding: 0 0 10px;
  border-top: 1px solid var(--dql-app-line);
}

.dql-app-ai-context-grid label {
  display: grid;
  gap: 5px;
  color: var(--dql-app-muted);
  font: 700 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-ai-context-grid input,
.dql-app-ai-context-grid select {
  width: 100%;
  height: 34px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface-muted);
  color: var(--dql-app-ink);
  outline: 0;
  padding: 0 10px;
  font: 12.5px var(--font-ui);
}

.dql-app-ai-send-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 3px;
}

.dql-app-ai-send-row span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dql-app-muted);
  font: 750 11px var(--font-ui);
}

.dql-app-ai-send-row span svg {
  color: var(--dql-app-green);
}

.dql-app-preview-panel { background: var(--dql-app-canvas); }
.dql-app-preview-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 20px 40px; }
.dql-app-preview-card {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  overflow: hidden;
}

.dql-app-preview-head {
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-preview-head h2 { margin: 0; font-size: 19px; }
.dql-app-preview-filters {
  display: flex;
  gap: 7px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
}

.dql-app-preview-filters span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dql-app-line);
  border-radius: 6px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 4px 9px;
  font-size: 11px;
}

.dql-app-preview-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 18px;
  min-height: 300px;
}

.dql-app-preview-empty {
  grid-column: 1 / -1;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--dql-app-faint);
  text-align: center;
}

.dql-app-preview-tile {
  grid-column: span 4;
  min-height: 136px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.dql-app-preview-tile.wide { grid-column: span 6; }
.dql-app-preview-tile.draft { border-color: rgba(202, 138, 4, 0.34); }
.dql-app-preview-tile-head,
.dql-app-preview-tile-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-preview-tile-head b { font-size: 12px; }
.dql-app-preview-tile-head span,
.dql-app-preview-tile-foot {
  color: var(--dql-app-faint);
  font: 700 9px var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
}

.dql-app-preview-tile-head span { margin-left: auto; }
.dql-app-preview-tile-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 10px;
}

.dql-app-preview-tile-body strong { font-size: 26px; }
.dql-app-preview-tile-body small { color: var(--dql-app-muted); }
.dql-app-preview-source {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}
.dql-app-preview-source > span {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
}
.dql-app-preview-source b {
  display: block;
  color: var(--dql-app-ink);
  font-size: 13px;
  line-height: 1.2;
}
.dql-app-preview-source p {
  margin: 4px 0 0;
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dql-app-preview-viz-row {
  display: flex;
  gap: 4px;
  padding: 0 10px 8px;
  align-items: center;
}
.dql-app-preview-viz-row button {
  width: 26px;
  height: 26px;
  border: 1px solid var(--dql-app-line);
  border-radius: 6px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.dql-app-preview-viz-row button.on {
  background: var(--dql-app-accent);
  border-color: var(--dql-app-accent);
  color: #fff;
}
.dql-app-preview-viz-row button:disabled {
  cursor: default;
  opacity: 0.58;
}
.dql-app-preview-tile-foot { border-bottom: 0; border-top: 1px solid var(--dql-app-line); }
.dql-app-preview-tile-foot b { margin-left: auto; color: var(--dql-app-green); }
.dql-app-preview-tile.draft .dql-app-preview-tile-foot b { color: var(--dql-app-orange); }
.dql-app-review-backlog {
  border-top: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
  padding: 14px 18px 18px;
}
.dql-app-review-backlog-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  color: var(--dql-app-muted);
}
.dql-app-review-backlog-head span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 850 12px var(--font-ui);
  color: var(--dql-app-ink);
}
.dql-app-review-backlog-head b {
  margin-left: auto;
  min-width: 22px;
  height: 22px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dql-app-orange-soft);
  color: var(--dql-app-orange);
  font: 800 10px var(--font-mono);
}
.dql-app-review-backlog-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.dql-app-review-backlog-item {
  border: 1px solid rgba(202, 138, 4, 0.22);
  border-radius: 8px;
  background: var(--dql-app-surface);
  padding: 11px;
  display: grid;
  gap: 9px;
}
.dql-app-review-backlog-item b {
  display: block;
  font-size: 12.5px;
  line-height: 1.25;
}
.dql-app-review-backlog-item p {
  margin: 5px 0 0;
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.4;
}
.dql-app-review-backlog-item > div:last-child {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.dql-app-review-backlog-item span {
  border: 1px solid rgba(79, 99, 215, 0.18);
  border-radius: 999px;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
  padding: 3px 7px;
  font: 750 10px var(--font-ui);
}
.dql-app-planner-flow {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  padding: 11px;
  margin-bottom: 12px;
}
.dql-app-planner-flow-title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--dql-app-accent);
  font: 850 12px var(--font-ui);
}
.dql-app-planner-flow p {
  margin: 7px 0 0;
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.42;
}
.dql-app-planner-flow-steps {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.dql-app-planner-flow-steps span {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 7px;
  color: var(--dql-app-muted);
  font-size: 11px;
  line-height: 1.35;
}
.dql-app-planner-flow-steps b {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
  font: 850 10px var(--font-mono);
}
.dql-app-plan-group-label {
  margin: 14px 0 4px;
  color: var(--dql-app-faint);
  font: 850 10px var(--font-mono);
  text-transform: uppercase;
}
.dql-app-plan-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-plan-item span { flex: 1; min-width: 0; }
.dql-app-plan-item b { display: block; font: 700 11.5px var(--font-mono); }
.dql-app-plan-item small { display: block; color: var(--dql-app-faint); font-size: 10px; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-plan-item em { color: var(--dql-app-faint); font: 700 9px var(--font-mono); text-transform: uppercase; font-style: normal; }

.dql-app-plan-session,
.dql-app-plan-warning,
.dql-app-plan-task {
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  padding: 8px 9px;
  background: var(--dql-app-surface-muted);
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.35;
}

.dql-app-plan-session span {
  display: block;
  color: var(--dql-app-ink);
  font-weight: 800;
}

.dql-app-plan-session small {
  display: block;
  margin-top: 2px;
  color: var(--dql-app-faint);
}

.dql-app-plan-warning {
  border-color: rgba(202, 138, 4, 0.24);
  background: var(--dql-app-orange-soft);
}

.dql-app-plan-task {
  display: flex;
  align-items: flex-start;
  gap: 7px;
}

.dql-app-plan-foot {
  margin-top: auto;
  padding: 14px;
  border-top: 2px solid var(--dql-app-accent);
  background: var(--dql-app-accent-soft);
}

.dql-app-leader {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11.5px;
  color: var(--dql-app-muted);
  margin: 5px 0;
}

.dql-app-leader i { flex: 1; border-bottom: 1.5px dotted var(--dql-app-line-2); transform: translateY(-3px); }
.dql-app-leader b { font-family: var(--font-mono); color: var(--dql-app-ink); }
.dql-app-leader.certified b { color: var(--dql-app-green); }
.dql-app-leader.draft b { color: var(--dql-app-orange); }

.dql-app-error {
  border: 1px solid rgba(220, 38, 38, 0.24);
  border-radius: 6px;
  background: rgba(220, 38, 38, 0.06);
  color: #b91c1c;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
  margin-top: 10px;
}

.dql-app-palette { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.dql-app-agent-scroll .dql-app-palette {
  margin-top: 12px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface-muted);
  padding: 10px;
  max-height: 360px;
}

.dql-app-palette-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.dql-app-palette-title span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dql-app-ink);
  font: 850 12px var(--font-ui);
}

.dql-app-palette-title b {
  margin-left: auto;
  color: var(--dql-app-faint);
  font: 700 9.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-palette-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 8px 10px;
  margin-bottom: 10px;
  font-size: 12px;
}

.dql-app-palette-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dql-app-ink);
  font: 12px var(--font-ui);
}

.dql-app-palette button {
  width: 100%;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface);
  color: var(--dql-app-ink);
  padding: 9px 10px;
  margin-bottom: 7px;
  display: flex;
  align-items: center;
  gap: 9px;
  text-align: left;
  cursor: pointer;
}

.dql-app-palette button.selected { border-color: var(--dql-app-accent); background: var(--dql-app-accent-soft); }
.dql-app-palette-icon {
  width: 25px;
  height: 25px;
  border-radius: 6px;
  background: #f1f5f9;
  color: var(--dql-app-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.dql-app-palette span:nth-child(2) { flex: 1; min-width: 0; }
.dql-app-palette b { display: block; font: 700 11px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-palette small { display: block; color: var(--dql-app-faint); font-size: 10px; }
.dql-app-palette i { color: var(--dql-app-green); font: 700 9px var(--font-mono); text-transform: uppercase; font-style: normal; }
.dql-app-palette-more {
  color: var(--dql-app-faint);
  text-align: center;
  font: 700 10px var(--font-mono);
  padding: 8px 0 2px;
}

.dql-app-view-topbar { position: relative; z-index: 4; }
.dql-app-view-topbar {
  min-height: 48px;
  padding: 7px 22px;
  box-shadow: 0 1px 0 var(--dql-app-line);
  background: var(--dql-app-surface);
  backdrop-filter: blur(10px);
}

.dql-app-crumb { color: var(--dql-app-muted); font: 700 11.5px var(--font-mono); }
.dql-app-filterbar {
  position: relative;
  z-index: 3;
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 26px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  flex-wrap: wrap;
}

.dql-app-filter-select {
  height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-control);
  padding: 0 10px;
}

.dql-app-filter-select span {
  color: var(--dql-app-faint);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-filter-select select,
.dql-app-filter-select input {
  border: 0;
  background: transparent;
  color: var(--dql-app-ink);
  outline: 0;
  font: 750 12.5px var(--font-ui);
  min-width: 0;
  max-width: 110px;
}

.dql-app-filter-select input[type="number"] {
  width: 64px;
}

.dql-app-filter-empty {
  color: var(--dql-app-faint);
  font: 750 11px var(--font-ui);
}

.dql-app-filter-note {
  margin-left: auto;
  color: var(--dql-app-faint);
  font: 700 11px var(--font-ui);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dql-app-toggle {
  border: 0;
  background: transparent;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dql-app-muted);
  cursor: pointer;
  font: 800 12px var(--font-ui);
}

.dql-app-toggle i {
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: #cbd5e1;
  position: relative;
}

.dql-app-toggle i::after {
  content: "";
  width: 14px;
  height: 14px;
  border-radius: 999px;
  position: absolute;
  top: 2px;
  left: 2px;
  background: #fff;
  transition: transform 140ms ease;
}

.dql-app-toggle.on i { background: var(--dql-app-accent); }
.dql-app-toggle.on i::after { transform: translateX(14px); }

.dql-app-view-wrap {
  position: relative;
  z-index: 1;
  width: min(1560px, calc(100% - 40px));
  margin: 0 auto;
  padding: 12px 0 60px;
}

.dql-app-title-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.dql-app-title-copy {
  flex: 1 1 420px;
  min-width: 0;
}

.dql-app-title-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.dql-app-title-meta > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dql-app-muted);
  font: 750 11.5px var(--font-ui);
  text-transform: capitalize;
}

.dql-app-title-row h1 {
  margin: 0;
  font-size: 26px;
  line-height: 1.1;
  font-weight: 820;
}

/* Reads as the heading until you focus it, so the page does not look like a form. */
.dql-app-title-input {
  margin: 0;
  width: 100%;
  font: 820 26px/1.1 var(--font-ui);
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 1px 6px;
  margin-left: -6px;
}

.dql-app-title-input:hover {
  border-color: var(--border-subtle);
}

.dql-app-title-input:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--bg-1);
}

.dql-app-title-row p {
  margin: 6px 0 0;
  color: var(--dql-app-muted);
  font-size: 13px;
  line-height: 1.45;
  max-width: 720px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dql-app-title-context {
  display: inline-flex;
  align-items: center;
  color: var(--dql-app-faint);
  font: 700 11.5px var(--font-mono);
}

/* The App-name rename sitting in the meta row: inherits that row's small
   type so it reads as the breadcrumb it replaces, not a second heading. */
.dql-app-title-input-compact {
  font: inherit;
  width: auto;
  padding: 1px 5px;
  margin-left: -5px;
}
.dql-app-title-context::before { content: "·"; margin-right: 8px; color: var(--dql-app-line-2); }

.dql-app-nav-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.dql-app-section-tabs,
.dql-app-page-picker {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dql-app-section-tabs {
  overflow-x: auto;
}

.dql-app-section-tabs button,
.dql-app-page-picker {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  font: 750 12px var(--font-ui);
}

.dql-app-section-tabs {
  gap: 6px;
}

.dql-app-section-tabs button {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dql-app-muted);
  min-height: 32px;
  padding: 6px 9px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font: 750 12px var(--font-ui);
}

.dql-app-section-tabs button {
  min-width: 38px;
  justify-content: center;
}

.dql-app-section-tabs .dql-app-tab-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-style: normal;
}

.dql-app-section-tabs .dql-app-tab-label {
  display: none;
}

.dql-app-section-tabs button.on .dql-app-tab-label {
  display: inline;
}

.dql-app-section-tabs button.on,
.dql-app-section-tabs button:hover {
  color: var(--dql-app-ink);
  background: var(--dql-app-accent-soft);
}

.dql-app-section-tabs button.on {
  box-shadow: inset 0 0 0 1px var(--dql-app-accent);
}

.dql-app-section-tabs b {
  color: var(--dql-app-accent);
  font-family: var(--font-mono);
  font-size: 10px;
}

.dql-app-page-picker {
  padding: 0 5px 0 10px;
  white-space: nowrap;
  max-width: min(440px, 100%);
}

.dql-app-page-picker > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dql-app-faint);
  font: 800 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-page-picker select {
  min-width: 210px;
  max-width: 310px;
  height: 30px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--dql-app-ink);
  font: 800 12px var(--font-ui);
  text-overflow: ellipsis;
}

.dql-app-page-picker button {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.dql-app-dashboard-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dql-app-view-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: start;
}

.dql-app-view-layout.no-explain { grid-template-columns: minmax(0, 1fr); }
.dql-app-main-column { min-width: 0; }
.dql-app-filter-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid var(--dql-app-line);
  border-radius: 12px;
  background: var(--dql-app-surface);
}
.dql-app-filter-row-copy { display: grid; gap: 2px; min-width: 170px; }
.dql-app-filter-row-copy b { font-size: 12px; color: var(--dql-app-ink); }
.dql-app-filter-row-copy span { font-size: 10.5px; color: var(--dql-app-faint); }
.dql-app-filter-row .dql-app-topbar-filters { flex: 1; }
.dql-app-filter-row-actions { display: flex; gap: 7px; margin-left: auto; }

.dql-app-explain-panel {
  position: sticky;
  top: 110px;
  width: clamp(420px, 29vw, 500px);
  min-width: 390px;
  max-width: min(520px, 40vw);
  min-height: 580px;
  height: calc(100vh - 142px);
  max-height: calc(100vh - 142px);
  border: 1px solid var(--dql-app-line);
  border-radius: 16px;
  background: var(--dql-app-surface);
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(15, 23, 42, 0.14);
}

.dql-app-explain-panel[data-expanded="true"] {
  width: min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, 52vw);
  max-width: min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, 52vw);
}

.dql-app-copilot-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dql-app-assistant-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  /* No background override: the shared AiSidePanel owns the surface so App AI,
     Notebook AI and Block AI read as the same panel rather than three skins. */
}

.dql-app-assistant-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dql-app-line);
  flex: none;
  background: var(--dql-app-surface);
}

.dql-app-assistant-focus {
  min-width: 0;
  display: grid;
  gap: 5px;
}

.dql-app-assistant-focus span {
  color: var(--dql-app-muted);
  font: 800 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-assistant-focus select {
  width: 100%;
  height: 36px;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-ink);
  padding: 0 10px;
  font: 750 12px var(--font-ui);
  cursor: pointer;
}

.dql-app-assistant-context-btn {
  flex: none;
  height: 30px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-control);
  color: var(--dql-app-muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  cursor: pointer;
  font: 800 11px var(--font-ui);
}

.dql-app-assistant-context-btn.on,
.dql-app-assistant-context-btn:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-assistant-context-btn.on svg { transform: rotate(180deg); }

.dql-app-assistant-context {
  display: grid;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface-muted);
}

.dql-app-assistant-context p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-assistant-context > div {
  display: grid;
  gap: 6px;
}

.dql-app-one-ai-panel {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--dql-app-surface);
}

.dql-app-one-ai-status {
  margin: 0;
  display: grid;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dql-app-line);
  background: color-mix(in srgb, var(--dql-app-surface-muted) 72%, var(--dql-app-surface));
  flex: none;
}

.dql-app-one-ai-status span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dql-app-green);
  font: 850 11px var(--font-ui);
}

.dql-app-one-ai-status > div {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.dql-app-one-ai-status > div::-webkit-scrollbar {
  display: none;
}

.dql-app-one-ai-status b {
  flex: none;
  min-width: 0;
  max-width: 190px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface);
  color: var(--dql-app-faint);
  font: 750 10.5px var(--font-ui);
  padding: 4px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-copilot-thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px 0 20px;
}

.dql-app-direct-ask {
  margin-top: 0;
  z-index: 4;
  border-top: 1px solid var(--dql-app-line);
  padding: 14px 16px 16px;
  display: grid;
  gap: 8px;
  flex: none;
  background: color-mix(in srgb, var(--dql-app-surface) 92%, transparent);
  backdrop-filter: blur(10px);
  box-shadow: 0 -12px 28px rgba(15, 23, 42, 0.05);
}

.dql-app-direct-ask-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
}

.dql-app-direct-ask-row textarea {
  width: 100%;
  min-height: 96px;
  max-height: 150px;
  resize: vertical;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 12px;
  background: var(--dql-app-surface);
  color: var(--dql-app-ink);
  padding: 12px 13px;
  font: 500 13.5px/1.45 var(--font-ui);
  outline: none;
}

.dql-app-direct-ask-row textarea:focus {
  border-color: rgba(79, 99, 215, 0.48);
  box-shadow: 0 0 0 3px rgba(79, 99, 215, 0.1);
}

.dql-app-direct-ask-row button,
.dql-app-direct-quick button {
  border: 1px solid var(--dql-app-line-2);
  border-radius: 12px;
  background: var(--dql-app-surface);
  color: var(--dql-app-ink);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  font-weight: 750;
}

.dql-app-direct-ask-row button {
  min-height: 48px;
  padding-inline: 13px;
  background: var(--dql-app-accent);
  border-color: var(--dql-app-accent);
  color: #fff;
}

.dql-app-direct-ask-row button:disabled {
  opacity: 0.55;
}

.dql-app-direct-quick {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.dql-app-direct-quick button {
  color: var(--dql-app-muted);
  font-size: 11.5px;
  padding: 7px 9px;
  white-space: nowrap;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-copilot-welcome {
  margin: 2px 16px 0;
  border: 1px dashed var(--dql-app-line-2);
  border-radius: 12px;
  background: var(--dql-app-surface);
  padding: 12px;
  display: grid;
  gap: 6px;
}

.dql-app-user-message {
  align-self: flex-end;
  max-width: calc(100% - 42px);
  margin: 0 16px 0 42px;
  border: 1px solid rgba(79, 99, 215, 0.28);
  border-radius: 14px 14px 5px 14px;
  background: var(--dql-app-accent);
  color: #fff;
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(79, 99, 215, 0.16);
}

.dql-app-user-message span {
  display: block;
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
  opacity: .72;
}

.dql-app-user-message p {
  margin: 4px 0 0;
  color: inherit;
  font-size: 12.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.dql-app-copilot-welcome span {
  color: var(--dql-app-accent);
  font: 850 10.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-welcome p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12.5px;
  line-height: 1.48;
}

.dql-app-direct-answer {
  border: 1px solid var(--dql-app-line);
  border-radius: 14px 14px 14px 5px;
  background: var(--dql-app-surface);
  margin: 0 42px 0 16px;
  padding: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
}

.dql-app-direct-answer > div:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.dql-app-direct-answer p {
  margin: 0;
  color: var(--dql-app-ink);
  font-size: 12.5px;
  line-height: 1.45;
}

.dql-app-direct-followups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.dql-app-direct-followups span,
.dql-app-direct-followups button {
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  padding: 3px 7px;
  color: var(--dql-app-muted);
  font-size: 10.5px;
  background: var(--dql-app-surface);
}

.dql-app-direct-followups button {
  cursor: pointer;
  font-weight: 750;
}

.dql-app-direct-followups button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-copilot-action-grid {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.dql-app-copilot-next-step {
  display: grid;
  gap: 8px;
  margin-top: 12px;
  border: 1px solid rgba(79, 99, 215, 0.18);
  border-radius: 11px;
  background: color-mix(in srgb, var(--dql-app-accent-soft) 58%, var(--dql-app-surface));
  padding: 10px;
}

.dql-app-copilot-next-step > span {
  color: var(--dql-app-accent);
  font: 850 10.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-copilot-next-step p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-analysis-handoff {
  margin: 0 16px;
  border: 1px solid rgba(22, 163, 74, 0.2);
  border-radius: 12px;
  background: rgba(22, 163, 74, 0.06);
  padding: 12px;
  display: grid;
  gap: 7px;
}

.dql-app-analysis-handoff > span {
  color: #15803d;
  font: 850 10.5px var(--font-mono);
  letter-spacing: .02em;
  text-transform: uppercase;
}

.dql-app-analysis-handoff p {
  margin: 0;
  color: var(--dql-app-ink);
  font-size: 12.5px;
  line-height: 1.45;
}

.dql-app-analysis-handoff small {
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-analysis-handoff > div {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 2px;
}

.dql-app-context-composer {
  margin: 0 16px;
  border: 1px solid rgba(79, 99, 215, 0.28);
  border-radius: 14px;
  background: var(--dql-app-surface);
  box-shadow: 0 16px 44px rgba(79, 99, 215, 0.11);
  padding: 12px;
  display: grid;
  gap: 9px;
}

.dql-app-context-composer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.dql-app-context-composer h4 {
  margin: 0;
  color: var(--dql-app-ink);
  font-size: 14px;
  line-height: 1.25;
}

.dql-app-context-composer p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-context-composer textarea {
  width: 100%;
  min-height: 158px;
  resize: vertical;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 8px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  outline: 0;
  padding: 10px;
  font: 12.5px/1.5 var(--font-ui);
}

.dql-app-context-composer textarea:focus {
  border-color: rgba(79, 99, 215, 0.54);
  box-shadow: 0 0 0 3px rgba(79, 99, 215, 0.1);
}

.dql-app-context-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.dql-app-context-chips span {
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface-muted);
  color: var(--dql-app-muted);
  padding: 4px 8px;
  font: 750 10px var(--font-ui);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-context-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dql-app-copilot-hero {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--dql-app-line);
  background: linear-gradient(180deg, var(--dql-app-surface), var(--dql-app-surface-muted));
}

.dql-app-copilot-kicker {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dql-app-muted);
  font: 750 10px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-kicker svg { color: var(--dql-app-accent); }
.dql-app-copilot-hero h3 {
  margin: 6px 0 0;
  color: var(--dql-app-ink);
  font-size: 19px;
  line-height: 1.15;
}

.dql-app-copilot-hero p {
  margin: 6px 0 0;
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.42;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.dql-app-copilot-decision {
  margin-top: 8px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface);
  padding: 7px 9px;
}

.dql-app-copilot-decision small,
.dql-app-copilot-facts small {
  display: block;
  color: var(--dql-app-muted);
  font: 750 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-decision b {
  display: block;
  margin-top: 3px;
  color: var(--dql-app-ink);
  font-size: 11.5px;
  line-height: 1.32;
}

.dql-app-copilot-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-top: 7px;
}

.dql-app-copilot-facts span {
  min-width: 0;
  border-radius: 7px;
  background: var(--dql-app-control);
  padding: 6px 8px;
}

.dql-app-copilot-facts b {
  display: block;
  margin-top: 2px;
  color: var(--dql-app-ink);
  font-size: 10.5px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-copilot-chat {
  flex: 1;
  min-height: 210px;
  padding: 9px 12px 12px;
}

.dql-app-explain-head { padding: 14px 16px 12px; border-bottom: 1px solid var(--dql-app-line); }
.dql-app-explain-head span,
.dql-app-ex-label {
  color: var(--dql-app-muted);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-explain-head h3 { margin: 3px 0 0; font-size: 17px; }
.dql-app-explain-head p { margin: 5px 0 0; color: var(--dql-app-muted); font-size: 11.5px; line-height: 1.45; }
.dql-app-ex-section { padding: 13px 16px; border-bottom: 1px solid var(--dql-app-line); }
.dql-app-ex-section.compact { padding-top: 11px; padding-bottom: 11px; }
.dql-app-copilot-controls {
  padding: 8px 12px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-focus {
  display: grid;
  gap: 5px;
}

.dql-app-copilot-focus span {
  color: var(--dql-app-muted);
  font: 700 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-focus select {
  width: 100%;
  min-width: 0;
  height: 34px;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  padding: 0 10px;
  font: 800 12px var(--font-ui);
}

.dql-app-copilot-empty {
  margin-top: 7px;
  color: var(--dql-app-faint);
  font-size: 11px;
}

.dql-app-copilot-brief {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-brief > div {
  min-width: 0;
  flex: 1;
}

.dql-app-copilot-brief span {
  display: inline-flex;
  color: var(--dql-app-green);
  font: 750 9px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-copilot-brief b {
  display: block;
  margin-top: 4px;
  color: var(--dql-app-ink);
  font-size: 13px;
  line-height: 1.25;
}

.dql-app-copilot-brief p {
  margin: 4px 0 0;
  color: var(--dql-app-muted);
  font-size: 11.5px;
  line-height: 1.35;
}

.dql-app-copilot-result-pill {
  flex: none;
  border-radius: 999px;
  border: 1px solid rgba(22, 163, 74, 0.24);
  background: var(--dql-app-green-soft);
  color: var(--dql-app-green) !important;
  padding: 4px 8px;
  white-space: nowrap;
}

.dql-app-copilot-prompts {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-prompts button {
  min-width: 0;
  height: 31px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 0 9px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-copilot-prompts button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-copilot-prompts svg {
  flex: 0 0 auto;
}

.dql-app-copilot-evidence {
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-copilot-evidence summary {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  cursor: pointer;
  color: var(--dql-app-muted);
  font: 800 11px var(--font-ui);
  list-style: none;
}

.dql-app-copilot-evidence summary::-webkit-details-marker { display: none; }
.dql-app-copilot-evidence summary span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dql-app-copilot-evidence summary small {
  margin-left: auto;
  min-width: 0;
  max-width: 160px;
  color: var(--dql-app-faint);
  font: 700 10px var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-copilot-evidence > div {
  display: grid;
  gap: 6px;
  padding: 0 12px 11px;
}

.dql-app-keyvalue-inline {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 8px;
  align-items: baseline;
  font-size: 11px;
}

.dql-app-keyvalue-inline span {
  color: var(--dql-app-faint);
  font-family: var(--font-mono);
}

.dql-app-keyvalue-inline b {
  min-width: 0;
  color: var(--dql-app-muted);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dql-app-block-cite {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 0;
  font-size: 11.5px;
}

.dql-app-block-cite span { flex: 1; min-width: 0; font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-block-cite b { color: var(--dql-app-faint); font: 10px var(--font-mono); }
.dql-app-flow { margin-top: 8px; }
.dql-app-flow-node {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 11.5px;
}

.dql-app-flow-node span {
  width: 28px;
  height: 23px;
  border-radius: 6px;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 700 8px var(--font-mono);
}

.dql-app-flow-node b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-flow-node small { color: var(--dql-app-faint); font: 9px var(--font-mono); }
.dql-app-flow i {
  display: block;
  width: 2px;
  height: 9px;
  background: var(--dql-app-accent);
  margin-left: 13px;
}

.dql-app-suggests { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.dql-app-focus-list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.dql-app-focus-list > span {
  color: var(--dql-app-faint);
  font-size: 12px;
}

.dql-app-focus-list button {
  min-width: 0;
  min-height: 34px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  cursor: pointer;
  text-align: left;
}

.dql-app-focus-list button.on {
  color: var(--dql-app-ink);
  border-color: rgba(79, 99, 215, 0.42);
  background: var(--dql-app-accent-soft);
}

.dql-app-focus-list button svg {
  flex: 0 0 auto;
  color: var(--dql-app-accent);
}

.dql-app-focus-list button span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 800 11.5px var(--font-ui);
}

.dql-app-focus-list button b {
  color: var(--dql-app-faint);
  font: 700 8.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-rail-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.dql-app-rail-title > span { flex: 1; }

.dql-app-rail-title button {
  height: 26px;
  border: 1px solid var(--dql-app-line);
  border-radius: 6px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-drilldown-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}

.dql-app-drilldown-grid button {
  min-width: 0;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 8px 6px;
  display: grid;
  justify-items: center;
  gap: 5px;
  cursor: pointer;
  font: 800 10.5px var(--font-ui);
}

.dql-app-drilldown-grid button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-rail-chat {
  height: 100%;
  min-height: 0;
  border: 1px solid var(--dql-app-line-2);
  border-radius: 8px;
  overflow: hidden;
  background: var(--dql-app-surface);
}

.dql-app-rail-chat.expanded {
  position: fixed;
  z-index: 80;
  right: 24px;
  top: 76px;
  bottom: 24px;
  width: min(760px, calc(100vw - 80px));
  height: auto;
  box-shadow: 0 18px 60px rgba(15, 23, 42, 0.24);
}

.dql-app-gapcard {
  margin: 12px;
  border-radius: 7px;
  background: var(--dql-app-orange-soft);
  padding: 11px 12px;
}

.dql-app-gapcard p { margin: 6px 0 0; color: var(--dql-app-muted); font-size: 11.5px; line-height: 1.45; }
.dql-app-research-shell {
  display: grid;
  gap: 14px;
  min-height: 620px;
}

.dql-app-research-shell.history-open {
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
}

.dql-app-research-shell.history-collapsed {
  grid-template-columns: minmax(0, 1fr);
}

.dql-app-research-shell.history-collapsed .dql-app-research-list {
  display: none;
}

.dql-app-research-list {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
}

.dql-app-research-list {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.dql-app-research-detail {
  padding: 0;
  min-width: 0;
  overflow: auto;
  background: transparent;
}

.dql-app-research-head,
.dql-app-research-titlebar,
.dql-app-research-evidence-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dql-app-research-head span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 850;
}

.dql-app-research-head > div {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.dql-app-research-head b {
  color: var(--dql-app-faint);
  font-family: var(--font-mono);
  font-size: 10px;
}

.dql-app-research-head button {
  height: 26px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface-muted);
  color: var(--dql-app-muted);
  padding: 0 9px;
  cursor: pointer;
  font: 800 10px var(--font-ui);
}

.dql-app-research-head button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-research-new {
  height: 32px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font: 800 12px var(--font-ui);
  cursor: pointer;
}

.dql-app-research-new:disabled { opacity: 0.65; cursor: not-allowed; }
.dql-app-research-items { display: grid; gap: 6px; overflow: auto; }
.dql-app-research-group-label {
  margin: 4px 2px 1px;
  color: var(--dql-app-faint);
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}
.dql-app-research-items button {
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--dql-app-ink);
  text-align: left;
  padding: 9px;
  cursor: pointer;
  min-width: 0;
}

.dql-app-research-items button.on,
.dql-app-research-items button:hover {
  border-color: var(--dql-app-line);
  background: var(--dql-app-control);
}

.dql-app-research-items button.status-error:not(.on) {
  color: var(--dql-app-muted);
  opacity: 0.72;
}

.dql-app-research-items button.status-error small {
  color: var(--dql-app-orange);
}

.dql-app-research-items button.status-ready small {
  color: var(--dql-app-green);
}

.dql-app-research-history-toggle {
  border-style: dashed !important;
  background: var(--dql-app-surface-muted) !important;
  color: var(--dql-app-muted) !important;
}

.dql-app-research-items span,
.dql-app-research-items small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-research-items span { font-weight: 800; font-size: 12px; }
.dql-app-research-items small { margin-top: 3px; color: var(--dql-app-muted); font-size: 10.5px; }
.dql-app-research-titlebar { align-items: flex-start; margin-bottom: 14px; }
.dql-app-research-titlebar h2 {
  margin: 2px 0 0;
  font-size: 20px;
  line-height: 1.2;
}

.dql-app-research-status {
  margin: 0 0 12px;
  border: 1px solid rgba(37, 99, 235, 0.26);
  border-radius: 8px;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
  padding: 10px 12px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font: 800 12px var(--font-ui);
}

.dql-app-research-status.opening {
  border-color: rgba(79, 99, 215, 0.28);
  background: color-mix(in srgb, var(--dql-app-accent-soft) 72%, var(--dql-app-surface));
}

.dql-app-research-status > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.dql-app-research-status small {
  color: var(--dql-app-muted);
  font: 700 11px/1.35 var(--font-ui);
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-report-toolbar {
  max-width: 1120px;
  margin: 0 auto 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dql-app-report-toolbar > div {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.dql-app-report-toolbar span {
  color: var(--dql-app-faint);
  font: 850 9.5px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-report-toolbar b {
  min-width: 0;
  color: var(--dql-app-ink);
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-research-creating {
  max-width: 760px;
  min-height: 340px;
  margin: 40px auto;
  border: 1px solid var(--dql-app-line);
  border-radius: 12px;
  background: var(--dql-app-surface);
  box-shadow: var(--dql-app-shadow);
  color: var(--dql-app-muted);
  padding: 42px;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  text-align: center;
}

.dql-app-research-creating.active {
  max-width: 920px;
  min-height: 420px;
  border-color: rgba(79, 99, 215, 0.24);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--dql-app-accent-soft) 24%, var(--dql-app-surface)), var(--dql-app-surface) 48%),
    var(--dql-app-surface);
}

.dql-app-research-creating svg {
  color: var(--dql-app-accent);
}

.dql-app-research-creating > span {
  color: var(--dql-app-accent);
  font: 850 10.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-research-creating h2 {
  margin: 0;
  color: var(--dql-app-ink);
  font-size: 24px;
}

.dql-app-research-creating p {
  margin: 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.6;
}

.dql-app-research-creating-steps {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
  max-width: 680px;
}

.dql-app-research-creating-steps small {
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface-muted);
  color: var(--dql-app-muted);
  padding: 5px 9px;
  font: 750 11px var(--font-ui);
}

.dql-app-research-report {
  max-width: 1040px;
  margin: 0 auto;
  border: 0;
  border-radius: 0;
  background: var(--dql-app-surface);
  box-shadow: none;
  overflow: visible;
}

.dql-app-report-hero {
  padding: 26px 34px 20px;
  border-bottom: 0;
  background: var(--dql-app-surface);
}

.dql-app-report-status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.dql-app-report-status-row > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--dql-app-muted);
  font: 850 10px var(--font-mono);
  text-transform: uppercase;
}

.dql-app-report-hero h2 {
  margin: 18px 0 0;
  color: var(--dql-app-ink);
  font-size: clamp(25px, 2.4vw, 34px);
  line-height: 1.08;
  max-width: 860px;
  text-wrap: balance;
}

.dql-app-report-hero p {
  margin: 14px 0 0;
  color: var(--dql-app-muted);
  font-size: 14px;
  line-height: 1.6;
  max-width: 850px;
}

.dql-app-report-context-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.dql-app-report-context-line span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 6px 10px;
  font-size: 11.5px;
  max-width: 100%;
}

.dql-app-report-context-line b {
  color: var(--dql-app-ink);
  font-weight: 850;
}

.dql-app-report-route {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 14px;
  border: 1px solid rgba(79, 99, 215, 0.18);
  border-radius: 10px;
  background: rgba(79, 99, 215, 0.055);
  padding: 10px 12px;
  max-width: 900px;
}

.dql-app-report-route > svg {
  color: var(--dql-app-accent);
  flex: 0 0 auto;
  margin-top: 2px;
}

.dql-app-report-route span {
  display: block;
  color: var(--dql-app-accent);
  font: 850 10.5px var(--font-mono);
  letter-spacing: .02em;
  text-transform: uppercase;
}

.dql-app-report-route p {
  margin: 5px 0 0;
  color: var(--dql-app-ink);
  font-size: 12.5px;
  line-height: 1.45;
}

.dql-app-report-route small {
  display: block;
  margin-top: 5px;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.dql-app-report-review-actions {
  position: relative;
}

.dql-app-report-review-actions summary {
  list-style: none;
  height: 32px;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  font: 800 11.5px var(--font-ui);
}

.dql-app-report-review-actions summary::-webkit-details-marker {
  display: none;
}

.dql-app-report-review-actions[open] summary,
.dql-app-report-review-actions summary:hover {
  color: var(--dql-app-accent);
  border-color: rgba(79, 99, 215, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-report-review-actions > div {
  position: absolute;
  z-index: 5;
  right: 0;
  top: calc(100% + 6px);
  min-width: 220px;
  border: 1px solid var(--dql-app-line);
  border-radius: 10px;
  background: var(--dql-app-surface);
  box-shadow: var(--dql-app-shadow);
  padding: 8px;
  display: grid;
  gap: 7px;
}

.dql-app-report-review-actions > div .dql-apps-btn {
  justify-content: flex-start;
  width: 100%;
}

.dql-app-report-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 14px;
  border: 1px solid rgba(217, 119, 6, 0.24);
  border-radius: 9px;
  background: rgba(251, 191, 36, 0.12);
  color: #92400e;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-warning svg {
  flex: none;
  margin-top: 1px;
}

.dql-app-report-section {
  padding: 24px 34px;
  border-bottom: 0;
}

.dql-app-report-section:last-child {
  border-bottom: 0;
}

.dql-app-report-section h3 {
  margin: 0 0 12px;
  color: var(--dql-app-ink);
  font-size: 17px;
  line-height: 1.25;
}

.dql-app-report-paper {
  color: var(--dql-app-ink);
  font-size: 14.5px;
  line-height: 1.78;
  padding: 26px 54px 20px;
}

.dql-app-report-paper h2,
.dql-app-report-paper h3 {
  margin: 18px 0 8px;
  color: var(--dql-app-ink);
  font-size: 18px;
  line-height: 1.22;
}

.dql-app-report-paper h2:first-child,
.dql-app-report-paper h3:first-child {
  margin-top: 0;
}

.dql-app-report-paper p,
.dql-app-report-paper ul,
.dql-app-report-paper ol {
  max-width: 900px;
}

.dql-app-report-dynamic-sections {
  display: grid;
  gap: 30px;
}

.dql-app-report-dynamic-section {
  border-left: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.dql-app-report-dynamic-head {
  display: grid;
  gap: 5px;
}

.dql-app-report-dynamic-head span {
  color: var(--dql-app-muted);
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-report-dynamic-head h3 {
  margin: 0;
  font-size: 20px;
  line-height: 1.18;
}

.dql-app-report-memo-body {
  display: grid;
  gap: 10px;
  max-width: 900px;
}

.dql-app-report-memo-body p {
  margin: 0;
  color: var(--dql-app-ink);
  font-size: 14.5px;
  line-height: 1.72;
}

.dql-app-report-dynamic-section ul {
  margin: 4px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 7px;
  max-width: 820px;
}

.dql-app-report-dynamic-section li {
  color: var(--dql-app-ink);
  font-size: 14.5px;
  line-height: 1.6;
}

.dql-app-report-evidence-story {
  display: grid;
  grid-template-columns: minmax(280px, 0.9fr) minmax(360px, 1.1fr);
  gap: 24px;
  align-items: start;
  margin: 6px 34px 12px;
  border: 1px solid color-mix(in srgb, var(--dql-app-line) 75%, transparent);
  border-radius: 12px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--dql-app-surface-muted) 64%, var(--dql-app-surface)), var(--dql-app-surface));
}

.dql-app-report-evidence-story.single {
  grid-template-columns: minmax(0, 1fr);
}

.dql-app-report-evidence-story .dql-app-report-numbers {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.dql-app-report-prose {
  font-size: 14px;
  line-height: 1.65;
}

.dql-app-report-callout {
  margin-top: 16px;
  border-left: 3px solid var(--dql-app-accent);
  background: var(--dql-app-surface-muted);
  padding: 12px 14px;
  color: var(--dql-app-muted);
}

.dql-app-report-numbers {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.dql-app-report-number {
  border: 1px solid var(--dql-app-line);
  border-radius: 9px;
  background: var(--dql-app-surface);
  padding: 13px;
  min-width: 0;
}

.dql-app-report-number span,
.dql-app-report-number small {
  display: block;
  color: var(--dql-app-muted);
}

.dql-app-report-number span {
  font: 850 9.5px var(--font-mono);
  letter-spacing: 0;
  text-transform: uppercase;
}

.dql-app-report-number b {
  display: block;
  margin-top: 7px;
  color: var(--dql-app-ink);
  font-size: 23px;
  line-height: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dql-app-report-number small {
  margin-top: 7px;
  font-size: 11.5px;
  line-height: 1.35;
}

.dql-app-report-drivers {
  display: grid;
  gap: 12px;
}

.dql-app-report-driver {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding: 13px 0;
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-report-driver:last-child { border-bottom: 0; }

.dql-app-report-driver > span {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--dql-app-accent-soft);
  color: var(--dql-app-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 850 12px var(--font-mono);
}

.dql-app-report-driver b {
  display: inline;
  color: var(--dql-app-ink);
  font-size: 14px;
}

.dql-app-report-driver em {
  margin-left: 8px;
  color: var(--dql-app-accent);
  font: 850 12px var(--font-mono);
  font-style: normal;
}

.dql-app-report-driver p,
.dql-app-report-muted {
  margin: 7px 0 0;
  color: var(--dql-app-muted);
  font-size: 13px;
  line-height: 1.55;
}

.dql-app-report-driver-chart {
  display: grid;
  gap: 13px;
}

.dql-app-report-driver-bar {
  display: grid;
  gap: 7px;
}

.dql-app-report-driver-bar > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.dql-app-report-driver-bar b {
  min-width: 0;
  color: var(--dql-app-ink);
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dql-app-report-driver-bar span {
  flex: none;
  color: var(--dql-app-accent);
  font: 850 11px var(--font-mono);
}

.dql-app-report-driver-bar i {
  display: block;
  width: var(--driver-width);
  min-width: 28px;
  height: 9px;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--dql-app-accent), rgba(79, 99, 215, 0.42));
}

.dql-app-report-driver-bar p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-appendix {
  padding: 0;
}

.dql-app-report-appendix summary {
  list-style: none;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 14px;
  align-items: center;
  cursor: pointer;
  padding: 18px 30px;
}

.dql-app-report-appendix summary::-webkit-details-marker {
  display: none;
}

.dql-app-report-appendix summary span {
  color: var(--dql-app-ink);
  font: 850 14px var(--font-ui);
}

.dql-app-report-appendix summary small {
  grid-column: 1 / 2;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.4;
}

.dql-app-report-appendix summary svg {
  grid-row: 1 / span 2;
  grid-column: 2;
  color: var(--dql-app-muted);
  transition: transform 140ms ease;
}

.dql-app-report-appendix[open] summary {
  border-bottom: 1px solid var(--dql-app-line);
}

.dql-app-report-appendix[open] summary svg {
  transform: rotate(180deg);
}

.dql-app-report-appendix .dql-app-research-evidence-head {
  align-items: flex-start;
  margin: 18px 30px 10px;
}

.dql-app-report-appendix .dql-app-research-evidence-head h3 {
  margin-bottom: 4px;
}

.dql-app-report-appendix .dql-app-research-evidence-head p {
  margin: 0;
  color: var(--dql-app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.dql-app-report-appendix .dql-app-research-table,
.dql-app-report-appendix .dql-app-research-sql-review,
.dql-app-report-appendix .dql-app-research-assumptions,
.dql-app-report-appendix .dql-app-research-code {
  margin-left: 30px;
  margin-right: 30px;
}

.dql-app-report-appendix > :last-child {
  margin-bottom: 24px;
}

.dql-app-research-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.dql-app-research-tabs button,
.dql-app-research-next button {
  border: 1px solid var(--dql-app-line);
  border-radius: 999px;
  background: var(--dql-app-surface);
  color: var(--dql-app-muted);
  font: 800 11px var(--font-ui);
  padding: 5px 9px;
  cursor: pointer;
}

.dql-app-research-tabs button.on,
.dql-app-research-tabs button:hover,
.dql-app-research-next button:hover {
  color: var(--dql-app-accent);
  border-color: rgba(37, 99, 235, 0.34);
  background: var(--dql-app-accent-soft);
}

.dql-app-research-code {
  margin: 10px 0 0;
  max-height: 320px;
  overflow: auto;
  border-radius: 8px;
  border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  padding: 11px;
  color: var(--dql-app-ink);
  font: 11px/1.5 var(--font-mono);
  white-space: pre-wrap;
}

.dql-app-research-sql-review {
  display: grid;
  gap: 10px;
  margin-top: 10px;
}

.dql-app-research-sql-review textarea {
  min-height: 260px;
  resize: vertical;
  border-radius: 8px;
  border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  color: var(--dql-app-ink);
  padding: 11px;
  font: 11px/1.5 var(--font-mono);
  outline: none;
}

.dql-app-research-sql-review textarea:focus {
  border-color: rgba(37, 99, 235, 0.42);
  box-shadow: 0 0 0 3px var(--dql-app-accent-soft);
}

.dql-app-research-assumptions {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.dql-app-research-assumptions p {
  margin: 0;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-surface);
  padding: 9px;
  color: var(--dql-app-muted);
  font-size: 12px;
}

.dql-app-research-table {
  margin-top: 10px;
  overflow: auto;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
}

.dql-app-research-table table {
  width: 100%;
  border-collapse: collapse;
  min-width: 520px;
}

.dql-app-research-table th,
.dql-app-research-table td {
  padding: 8px 9px;
  border-bottom: 1px solid var(--dql-app-line);
  text-align: left;
  font-size: 11.5px;
  white-space: nowrap;
}

.dql-app-research-table th {
  color: var(--dql-app-muted);
  background: var(--dql-app-control);
  font-weight: 850;
}

.dql-app-research-next {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.dql-app-simple-list,
.dql-app-settings-grid { display: grid; gap: 10px; }
.dql-app-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.dql-app-panel-card {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  padding: 13px;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.dql-app-panel-card > span {
  width: 30px;
  height: 30px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dql-app-accent);
  background: var(--dql-app-accent-soft);
  flex: none;
}

.dql-app-panel-card b { display: block; }
.dql-app-panel-card span:last-child { color: var(--dql-app-muted); font-size: 12px; }
.dql-app-empty {
  min-height: 260px;
  border: 1px dashed var(--dql-app-line-2);
  border-radius: 8px;
  background: var(--dql-app-surface);
  color: var(--dql-app-faint);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  padding: 28px;
}

.dql-app-empty.compact { min-height: 120px; padding: 18px; }
.dql-app-empty b { color: var(--dql-app-ink); }
.dql-app-empty span { max-width: 440px; font-size: 12px; line-height: 1.45; }
.dql-app-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(15, 23, 42, 0.36);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.dql-app-modal {
  width: min(480px, 94vw);
  border-radius: 8px;
  background: var(--dql-app-surface);
  box-shadow: 0 18px 60px rgba(15, 23, 42, 0.28);
  padding: 18px;
  display: grid;
  gap: 12px;
}

.dql-app-modal h3 { margin: 0; }
.dql-app-modal p { margin: 0; color: var(--dql-app-muted); font-size: 12px; }
.dql-app-modal > div:last-child { display: flex; justify-content: flex-end; gap: 8px; }
.dql-app-page-explore {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 2px 8px;
  align-items: center;
  text-align: left;
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  padding: 9px 10px;
  cursor: pointer;
}
.dql-app-page-explore.on { border-color: var(--dql-app-accent); background: var(--dql-app-accent-soft); }
.dql-app-page-explore > span { grid-row: 1 / span 2; display: grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--dql-app-line-2); border-radius: 5px; }
.dql-app-page-explore.on > span { border-color: var(--dql-app-accent); color: var(--dql-app-accent); }
.dql-app-page-explore b { font-size: 12px; }
.dql-app-page-explore small,
.dql-app-page-source-policy { color: var(--dql-app-muted); font-size: 10.5px; line-height: 1.35; }

@media (max-width: 1120px) {
  .dql-apps-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dql-app-create-workspace,
  .dql-app-create-workspace.classic {
    grid-template-columns: 1fr;
    align-content: start;
    overflow: auto;
  }
  .dql-app-create-workspace .dql-app-panel {
    min-height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--dql-app-line);
  }
  .dql-app-ai-start,
  .dql-app-ai-generated-grid {
    grid-template-columns: 1fr;
  }
  .dql-app-filterbar {
    flex-wrap: nowrap;
    gap: 6px;
    padding: 7px 22px;
    overflow-x: auto;
  }
  .dql-app-filter-note {
    width: 30px;
    height: 30px;
    justify-content: center;
    gap: 0;
    border: 1px solid var(--dql-app-line);
    border-radius: 8px;
    background: var(--dql-app-control);
    font-size: 0;
    flex: 0 0 auto;
  }
  .dql-app-filter-note svg {
    width: 14px;
    height: 14px;
  }
  .dql-app-filter-select,
  .dql-app-toggle {
    flex: 0 0 auto;
  }
  .dql-app-toggle {
    gap: 6px;
    font-weight: 750;
  }
  .dql-app-review-backlog-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .dql-app-view-layout { grid-template-columns: 1fr; }
  .dql-app-view-topbar {
    align-content: flex-start;
    align-items: flex-start;
    min-height: 132px;
    row-gap: 8px;
  }
  .dql-app-topbar-divider {
    display: none;
  }
  .dql-app-topbar-filters {
    flex: 1 1 100%;
    order: 2;
  }
  .dql-app-filter-row { align-items: stretch; }
  .dql-app-filter-row-copy, .dql-app-filter-row-actions { width: 100%; }
  .dql-app-filter-row-actions { justify-content: flex-end; }
  .dql-app-view-actions {
    flex: 1 1 100%;
    justify-content: flex-start;
    margin-left: 0;
    order: 3;
  }
  .dql-app-research-shell {
    grid-template-columns: 1fr;
  }
  .dql-app-research-detail {
    order: 1;
  }
  .dql-app-research-list {
    order: 2;
  }
  .dql-app-explain-panel {
    position: static;
    width: 100%;
    max-width: none;
    height: min(680px, calc(100vh - 24px));
    resize: none;
    max-height: none;
  }
  .dql-app-explain-panel[data-expanded="true"] {
    width: 100%;
    max-width: none;
  }
}

@media (max-width: 760px) {
  .dql-apps-wrap,
  .dql-app-view-wrap {
    width: min(100% - 16px, calc(100vw - 104px));
    max-width: calc(100vw - 104px);
    margin: 0 auto;
    padding-bottom: 48px;
  }
  .dql-apps-libbar,
  .dql-app-buildbar,
  .dql-app-view-topbar,
  .dql-app-filterbar {
    align-items: stretch;
    flex-direction: column;
    overflow-x: visible;
  }
  .dql-app-filter-note {
    width: auto;
    height: auto;
    margin-left: 0;
    justify-content: flex-start;
    gap: 6px;
    font-size: 11px;
  }
  .dql-apps-grid,
  .dql-app-form-grid.two,
  .dql-app-settings-grid,
  .dql-app-ai-filter-preview { grid-template-columns: 1fr; }
  .dql-apps-ai-entry-box {
    grid-template-columns: 1fr;
  }
  .dql-apps-ai-entry-box button {
    width: 100%;
  }
  .dql-apps-ai-entry-foot {
    align-items: stretch;
    flex-direction: column;
  }
  .dql-apps-ai-entry-secondary {
    justify-content: center;
  }
  .dql-app-create-workspace.clean {
    padding: 16px;
  }
  .dql-app-ai-start-card {
    padding: 15px;
  }
  .dql-app-ai-start-card textarea {
    min-height: 150px;
    font-size: 15px;
    padding-bottom: 48px;
  }
  .dql-app-ai-start-send {
    right: 14px;
    bottom: 14px;
  }
  .dql-app-ai-generated-head {
    align-items: stretch;
    flex-direction: column;
  }
  .dql-app-mode-seg { margin: 0; width: 100%; }
  .dql-app-mode-seg button { flex: 1; }
  .dql-app-build-actions,
  .dql-app-view-actions { margin-left: 0; width: 100%; flex-wrap: wrap; }
  .dql-app-nav-row {
    width: 100%;
    justify-content: flex-start;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .dql-app-section-tabs {
    flex: 0 0 auto;
    max-width: none;
  }
  .dql-app-section-tabs button {
    min-width: auto;
    white-space: nowrap;
  }
  .dql-app-section-tabs .dql-app-tab-label {
    display: inline;
  }
  .dql-app-explain-panel {
    order: -1;
    min-width: 0;
    height: min(620px, calc(100vh - 160px));
    min-height: 420px;
    margin-bottom: 12px;
  }
  .dql-app-assistant-top {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }
  .dql-app-assistant-focus {
    flex: 1 1 100%;
  }
  .dql-app-assistant-focus select {
    width: 100%;
    max-width: none;
  }
  .dql-app-assistant-context-btn {
    position: static;
    justify-self: start;
  }
  .dql-app-direct-ask-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .dql-app-direct-ask-row button {
    width: 100%;
  }
  .dql-app-page-picker {
    flex: 0 0 min(100%, 360px);
  }
  .dql-app-page-picker select { min-width: 0; max-width: 100%; }
  .dql-app-report-hero {
    padding: 18px 16px 16px;
  }
  .dql-app-report-status-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .dql-app-report-hero h2 {
    font-size: 26px;
    line-height: 1.08;
    overflow-wrap: anywhere;
  }
  .dql-app-report-section {
    padding: 18px 16px;
  }
  .dql-app-report-paper {
    padding: 18px 18px 14px;
  }
  .dql-app-report-evidence-story {
    margin: 4px 16px 10px;
  }
  .dql-app-report-appendix {
    padding: 0;
  }
  .dql-app-report-appendix summary {
    padding: 16px;
  }
  .dql-app-report-appendix .dql-app-research-evidence-head,
  .dql-app-report-appendix .dql-app-research-table,
  .dql-app-report-appendix .dql-app-research-sql-review,
  .dql-app-report-appendix .dql-app-research-assumptions,
  .dql-app-report-appendix .dql-app-research-code {
    margin-left: 16px;
    margin-right: 16px;
  }
  .dql-app-direct-quick,
  .dql-app-report-evidence-story,
  .dql-app-report-numbers {
    grid-template-columns: 1fr;
  }
  .dql-app-report-evidence-story .dql-app-report-numbers {
    grid-template-columns: 1fr;
  }
  .dql-app-report-context-line span {
    white-space: normal;
  }
  .dql-app-preview-tile,
  .dql-app-preview-tile.wide { grid-column: 1 / -1; }
  .dql-app-drilldown-grid {
    grid-template-columns: 1fr;
  }
}

/* ══ Redesigned AI build flow (Apps Redesign.dc.html) ══ */
@keyframes dql-app-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
@keyframes dql-app-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
@keyframes dql-app-orb { 0%, 100% { box-shadow: 0 0 0 0 rgba(107, 93, 211, 0); } 50% { box-shadow: 0 0 13px 1px rgba(107, 93, 211, 0.4); } }
@keyframes dql-app-step { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: none; } }

.dql-app-flow-scroll { min-height: 100%; }
.dql-app-flow {
  width: min(880px, calc(100% - 48px));
  margin: 0 auto;
  padding: 28px 0 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dql-app-flow-head h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; color: var(--dql-app-ink); }
.dql-app-flow-head p { margin: 3px 0 0; font-size: 12.5px; color: var(--dql-app-faint); }
.dql-app-flow-bubble {
  align-self: flex-end;
  max-width: 78%;
  background: var(--dql-app-surface-muted);
  color: var(--dql-app-ink);
  border-radius: 16px 16px 4px 16px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
  animation: dql-app-fadein 0.2s ease-out;
}
.dql-app-buildstream { display: flex; gap: 12px; animation: dql-app-fadein 0.25s ease-out; }
.dql-app-buildorb {
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--dql-app-accent-soft);
  border: 1px solid var(--dql-app-line);
  color: var(--dql-app-accent);
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
  animation: dql-app-orb 1.8s ease-in-out infinite;
}
.dql-app-buildorb.still { animation: none; }
.dql-app-buildbody { display: flex; flex-direction: column; gap: 7px; padding-top: 4px; min-width: 0; }
.dql-app-buildbody.wide { flex: 1; gap: 10px; }
.dql-app-shimmer {
  font-size: 13.5px; font-weight: 700; letter-spacing: -0.01em;
  background-image: linear-gradient(100deg, var(--dql-app-ink) 25%, var(--dql-app-accent) 50%, var(--dql-app-ink) 75%);
  background-size: 220% 100%;
  -webkit-background-clip: text; background-clip: text;
  color: transparent; -webkit-text-fill-color: transparent;
  animation: dql-app-shimmer 2.4s linear infinite;
}
.dql-app-buildsteps { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--dql-app-faint); line-height: 1.45; }
.dql-app-buildsteps > span { display: inline-flex; align-items: center; gap: 6px; animation: dql-app-step 0.3s ease-out both; }
.dql-app-buildsteps .ok { color: var(--dql-app-green); flex: none; }
.dql-app-buildsteps code { font-family: var(--font-mono); font-size: 10.5px; }
.dql-app-buildsteps .dot { width: 5px; height: 5px; border-radius: 999px; background: var(--dql-app-accent); margin: 0 3px; flex: none; }
.dql-app-proposal-lede { font-size: 13.5px; line-height: 1.6; color: var(--dql-app-ink); }
.dql-app-buildbrief-name {
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr);
  align-items: center;
  gap: 9px;
  color: var(--dql-app-faint);
  font-size: 10.5px;
  font-weight: 750;
}
.dql-app-buildbrief-name input {
  min-width: 0;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  padding: 6px 8px;
  font: 12px var(--font-ui);
}
.dql-app-buildbrief-edit {
  border: 1px solid var(--dql-app-line);
  border-radius: 8px;
  background: var(--dql-app-surface);
  padding: 7px 9px;
}
.dql-app-buildbrief-edit summary {
  color: var(--dql-app-muted);
  cursor: pointer;
  font-size: 11px;
  font-weight: 750;
}
.dql-app-buildbrief-edit > div { display: grid; gap: 6px; margin-top: 8px; }
.dql-app-buildbrief-edit label { display: grid; grid-template-columns: minmax(0, 1fr) 130px; gap: 7px; }
.dql-app-buildbrief-edit input,
.dql-app-buildbrief-edit select {
  min-width: 0;
  border: 1px solid var(--dql-app-line);
  border-radius: 6px;
  background: var(--dql-app-control);
  color: var(--dql-app-ink);
  padding: 5px 7px;
  font: 11px var(--font-ui);
}
.dql-app-proposal-card {
  border: 1px solid var(--dql-app-line);
  border-radius: 11px;
  background: var(--dql-app-surface);
  overflow: hidden;
}
.dql-app-proposal-row {
  display: flex; align-items: center; gap: 10px;
  width: 100%;
  padding: 10px 13px;
  border: 0; border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  cursor: pointer; text-align: left; font-family: inherit;
}
.dql-app-proposal-row:hover { background: var(--dql-app-canvas); }
.dql-app-proposal-row.off { background: var(--dql-app-canvas); }
.dql-app-prop-check {
  width: 16px; height: 16px; border-radius: 4.5px;
  border: 1.5px solid var(--dql-app-line-2);
  background: var(--dql-app-surface);
  color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  flex: none;
}
.dql-app-prop-check.on { border-color: var(--dql-app-accent); background: var(--dql-app-accent); }
.dql-app-prop-glyph {
  width: 26px; height: 26px; border-radius: 6px;
  background: var(--dql-app-accent-soft); color: var(--dql-app-accent);
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; font-size: 13px;
}
.dql-app-prop-glyph.green { background: var(--dql-app-green-soft); color: var(--dql-app-green); }
.dql-app-prop-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dql-app-prop-name b { font-size: 12.5px; font-weight: 650; color: var(--dql-app-ink); font-family: var(--font-mono); }
.dql-app-prop-name small { font-size: 11px; color: var(--dql-app-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-app-prop-badge {
  flex: none; border-radius: 999px; padding: 2px 8px;
  font-size: 9.5px; font-weight: 700;
}
.dql-app-prop-badge.certified { border: 1px solid rgba(46, 139, 87, 0.33); color: var(--dql-app-green); background: var(--dql-app-green-soft); }
.dql-app-prop-badge.draft { border: 1px solid rgba(178, 107, 31, 0.31); color: var(--dql-app-orange); background: var(--dql-app-orange-soft); }
.dql-app-prop-viz { flex: none; font-size: 10.5px; color: var(--dql-app-faint); }
.dql-app-addmore {
  display: flex; align-items: center; gap: 7px;
  width: 100%; padding: 10px 13px;
  border: 0; background: none;
  color: var(--dql-app-accent);
  font-size: 12px; font-weight: 650; cursor: pointer; font-family: inherit; text-align: left;
}
.dql-app-addmore:hover { background: var(--dql-app-accent-soft); }
.dql-app-addmore-panel { border-top: 1px solid var(--dql-app-line); animation: dql-app-fadein 0.15s ease-out; }
.dql-app-addmore-search {
  display: flex; align-items: center; gap: 7px;
  padding: 9px 13px;
  border-bottom: 1px solid var(--dql-app-line);
  background: var(--dql-app-canvas);
  color: var(--dql-app-faint);
}
.dql-app-addmore-search input {
  flex: 1; border: 0; background: none; outline: none;
  font-size: 12px; font-family: inherit; color: var(--dql-app-ink); min-width: 0;
}
.dql-app-addmore-row {
  display: flex; align-items: center; gap: 9px;
  width: 100%; padding: 8px 13px;
  border: 0; border-bottom: 1px solid var(--dql-app-line);
  background: none; cursor: pointer; text-align: left; font-family: inherit;
  color: var(--dql-app-accent);
}
.dql-app-addmore-row:hover { background: var(--dql-app-accent-soft); }
.dql-app-addmore-row span { flex: 1; min-width: 0; font-size: 12px; font-family: var(--font-mono); color: var(--dql-app-ink); }
.dql-app-addmore-row small { flex: none; font-size: 10.5px; color: var(--dql-app-faint); }
.dql-app-addmore-hint { padding: 9px 13px; font-size: 11px; color: var(--dql-app-faint); }
.dql-app-detected { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; color: var(--dql-app-faint); }
.dql-app-detected-label { font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; font-size: 9.5px; }
.dql-app-detected-pill {
  border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface);
  border-radius: 999px; padding: 2.5px 9px;
  color: var(--dql-app-muted);
}
.dql-app-flow-gaps { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--dql-app-orange); }
.dql-app-flow-gaps span { display: inline-flex; align-items: center; gap: 6px; }
.dql-app-flow-actions { display: flex; align-items: center; gap: 8px; }
.dql-app-flow-build {
  display: inline-flex; align-items: center; gap: 7px;
  height: 34px; padding: 0 16px;
  border-radius: 8px; border: 0;
  background: var(--dql-app-accent); color: #fff;
  font-size: 12.5px; font-weight: 650; cursor: pointer; font-family: inherit;
  box-shadow: 0 1px 5px rgba(107, 93, 211, 0.3);
}
.dql-app-flow-build:hover { filter: brightness(0.95); }
.dql-app-flow-build:disabled { opacity: 0.55; cursor: default; }
.dql-app-flow-reset {
  height: 34px; padding: 0 13px;
  border-radius: 8px; border: 1px solid var(--dql-app-line);
  background: var(--dql-app-surface); color: var(--dql-app-muted);
  font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit;
}
.dql-app-flow-reset:hover { background: var(--dql-app-surface-muted); }
/* View / Edit segmented toggle (app workspace top bar) */
.dql-app-modeseg {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 2px;
  border: 1px solid var(--dql-app-line);
  border-radius: 7px;
  background: var(--dql-app-canvas);
}
.dql-app-modeseg button {
  border: 0; border-radius: 5px;
  padding: 4px 12px;
  font-size: 11.5px; font-weight: 600;
  cursor: pointer; font-family: inherit;
  display: inline-flex; align-items: center; gap: 5px;
  background: transparent; color: var(--dql-app-faint);
}
.dql-app-modeseg button.on { background: var(--dql-app-accent-soft); color: var(--dql-app-accent); }
`;
