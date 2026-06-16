import type { Theme } from '../../themes/notebook-theme';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Blocks,
  BookOpenText,
  Database,
  FileJson,
  GitBranch,
  Network,
  Play,
  ShieldCheck,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { BlockStudioDbtStatus, NotebookFile, SemanticLayerState, SidebarPanel } from '../../store/types';
import { api } from '../../api/client';
import { SetupWizard } from '../modals/SetupWizard';

type StepState = 'ready' | 'active' | 'waiting';

interface ConnectionInfo {
  default: string;
  connections: Record<string, unknown>;
  dbtProfiles?: Array<{ id: string; profileName: string; targetName: string; missingFields: string[] }>;
}

interface WorkflowStep {
  id: string;
  number: string;
  title: string;
  body: string;
  state: StepState;
  Icon: LucideIcon;
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  evidence: string[];
}

const ARTIFACTS = [
  ['dql-manifest.json', 'Compiled project graph for lineage, trust, Apps, and AI context.'],
  ['semantic-layer/', 'Imported or authored metrics, dimensions, models, and saved queries.'],
  ['connections', 'Warehouse credentials and schema status for executing blocks.'],
  ['blocks/', 'Reusable DQL blocks built from dbt objects, SQL, tables, or semantic metrics.'],
  ['notebooks/', 'Analysis workspaces where users explore, edit, and assemble blocks.'],
  ['apps/', 'Published consumption surfaces for stakeholders.'],
];

export function HomePage() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const counts = countFiles(state.files);
  const semanticCounts = countSemanticObjects(state.semanticLayer);
  const dbtStatus = state.blockStudioDbtStatus;
  const sourceCounts = {
    models: Math.max(semanticCounts.models, dbtStatus?.counts.semanticModels ?? 0, dbtStatus?.counts.models ?? 0),
    metrics: Math.max(semanticCounts.metrics, dbtStatus?.counts.metrics ?? 0),
    dimensions: semanticCounts.dimensions,
    savedQueries: Math.max(semanticCounts.savedQueries, dbtStatus?.counts.savedQueries ?? 0),
  };
  const schemaCounts = countSchema(state.schemaTables);

  const [connections, setConnections] = useState<ConnectionInfo | null>(null);
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void api.getConnections().then((info) => {
      if (!cancelled) setConnections(info as ConnectionInfo);
    });

    void api.getBlockStudioDbtStatus()
      .then((status: BlockStudioDbtStatus) => {
        if (!cancelled) dispatch({ type: 'SET_BLOCK_STUDIO_DBT_STATUS', status });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'SET_BLOCK_STUDIO_DBT_STATUS', status: null });
      });

    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    void api.getSemanticLayer()
      .then((layer) => {
        if (!cancelled) dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
      })
      .finally(() => {
        if (!cancelled) dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false });
      });

    dispatch({ type: 'SET_APPS_LOADING', loading: true });
    void api.listApps()
      .then((apps) => {
        if (!cancelled) dispatch({ type: 'SET_APPS', apps });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'SET_APPS', apps: [] });
      })
      .finally(() => {
        if (!cancelled) dispatch({ type: 'SET_APPS_LOADING', loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const connectionCount = Object.keys(connections?.connections ?? {}).length;
  const dbtProfileCount = connections?.dbtProfiles?.length ?? 0;
  const dbtArtifactsReady = Boolean(dbtStatus?.artifacts.manifest.exists || dbtStatus?.artifacts.semanticManifest.exists);
  const sourceReady = dbtArtifactsReady || state.semanticLayer.available || semanticCounts.total > 0 || counts.blocks > 0;
  const connectionReady = connectionCount > 0 || state.schemaTables.length > 0;
  const dqlReady = counts.blocks > 0;
  const notebookReady = counts.notebooks > 0;
  const appReady = state.apps.length > 0;

  const currentStep = !sourceReady
    ? 'source'
    : !connectionReady
      ? 'connection'
      : !dqlReady
        ? 'build'
        : 'notebook';

  const openPanel = (panel: SidebarPanel) => {
    dispatch({ type: 'SET_SIDEBAR_PANEL', panel });
  };

  const openSemanticBlock = () => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' });
    dispatch({ type: 'OPEN_NEW_BLOCK_MODAL', blockType: 'semantic' });
  };

  const openSqlImport = () => {
    dispatch({ type: 'SET_MAIN_VIEW', view: 'imports' });
  };

  const refreshAfterSemanticImport = async () => {
    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: true });
    try {
      const [layer, files] = await Promise.all([
        api.getSemanticLayer(),
        api.listNotebooks(),
      ]);
      dispatch({ type: 'SET_SEMANTIC_LAYER', layer });
      dispatch({ type: 'SET_FILES', files });
    } finally {
      dispatch({ type: 'SET_SEMANTIC_LOADING', loading: false });
    }
  };

  const steps: WorkflowStep[] = useMemo(() => [
    {
      id: 'source',
      number: '1',
      title: 'Connect dbt and compile context',
      body: 'Start with the dbt repo or semantic source. Import models, metrics, dimensions, and compile the local manifest context that DQL uses for lineage and AI.',
      state: sourceReady ? 'ready' : currentStep === 'source' ? 'active' : 'waiting',
      Icon: GitBranch,
      primaryLabel: sourceReady ? 'Refresh semantic import' : 'Connect dbt repo',
      onPrimary: () => setSetupWizardOpen(true),
      secondaryLabel: 'Browse lineage',
      onSecondary: () => openPanel('lineage'),
      evidence: [
        `${sourceCounts.models} semantic models`,
        `${sourceCounts.metrics} metrics`,
        `${sourceCounts.dimensions} dimensions`,
        `${counts.blocks + counts.businessViews} DQL artifacts`,
      ],
    },
    {
      id: 'connection',
      number: '2',
      title: 'Connect database and test access',
      body: 'Use dbt profiles.yml where your runtime already resolves it, or enter warehouse credentials directly. Test the connection and refresh schema before building blocks.',
      state: connectionReady ? 'ready' : currentStep === 'connection' ? 'active' : 'waiting',
      Icon: Database,
      primaryLabel: connectionReady ? 'Manage connections' : 'Add database connection',
      onPrimary: () => openPanel('connection'),
      secondaryLabel: 'Open connections',
      onSecondary: () => openPanel('connection'),
      evidence: [
        `${connectionCount} connection${connectionCount === 1 ? '' : 's'}`,
        `${dbtProfileCount} dbt profile target${dbtProfileCount === 1 ? '' : 's'}`,
        `${schemaCounts.tables} tables`,
        `${schemaCounts.columns} columns`,
      ],
    },
    {
      id: 'build',
      number: '3',
      title: 'Build DQL blocks from trusted objects',
      body: 'Create a reusable DQL block from semantic metrics, dbt objects, database tables, or imported SQL. Blocks become the reviewed unit for notebooks, lineage, and Apps.',
      state: dqlReady ? 'ready' : currentStep === 'build' ? 'active' : 'waiting',
      Icon: Blocks,
      primaryLabel: dqlReady ? 'Open Block Studio' : 'Build DQL block',
      onPrimary: () => dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' }),
      secondaryLabel: 'Import existing SQL',
      onSecondary: openSqlImport,
      evidence: [
        `${counts.blocks} blocks`,
        `${counts.terms} business terms`,
        `${counts.businessViews} business views`,
      ],
    },
    {
      id: 'notebook',
      number: '4',
      title: 'Analyze in notebooks and publish to Apps',
      body: 'Search, add, and edit notebooks around reviewed blocks. When the answer is ready, promote it into an App for stakeholder consumption.',
      state: notebookReady || appReady ? 'ready' : currentStep === 'notebook' ? 'active' : 'waiting',
      Icon: BookOpenText,
      primaryLabel: notebookReady ? 'Open notebooks' : 'Create notebook',
      onPrimary: () => {
        if (notebookReady) openPanel('files');
        else dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' });
      },
      secondaryLabel: appReady ? 'Open Apps' : 'Build App',
      onSecondary: () => openPanel('apps'),
      evidence: [
        `${counts.notebooks} notebooks`,
        `${state.apps.length} apps`,
        `${state.apps.reduce((sum, app) => sum + app.dashboards.length, 0)} dashboards`,
      ],
    },
  ], [
    appReady,
    connectionCount,
    connectionReady,
    counts.blocks,
    counts.businessViews,
    counts.notebooks,
    counts.terms,
    currentStep,
    dqlReady,
    dbtProfileCount,
    notebookReady,
    schemaCounts.columns,
    schemaCounts.tables,
    sourceCounts.dimensions,
    sourceCounts.metrics,
    sourceReady,
    state.apps,
  ]);

  const readyCount = steps.filter((step) => step.state === 'ready').length;

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'auto',
        background: t.appBg,
      }}
    >
      <style>{HOME_PAGE_STYLES}</style>
      <main className="dql-home-page">
        <section className="dql-home-hero" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
          <div className="dql-home-hero-copy">
            <div className="dql-home-brand-row">
              <span className="dql-home-logo">DQL</span>
              <span style={{ color: t.textSecondary }}>Guided setup</span>
            </div>
            <h1 style={{ color: t.textPrimary }}>Set up your analytics workspace</h1>
            <p className="dql-home-lead" style={{ color: t.textSecondary }}>
              Connect source context, verify database access, build reviewed DQL blocks,
              then use notebooks and Apps as the delivery layer.
            </p>
            <div className="dql-home-cta-row">
              <button className="dql-home-primary-btn" onClick={() => setSetupWizardOpen(true)}>
                <GitBranch size={15} strokeWidth={2.2} aria-hidden="true" />
                Connect dbt repo
              </button>
              <button className="dql-home-secondary-btn" onClick={() => openPanel('connection')}>
                <Database size={15} strokeWidth={2} aria-hidden="true" />
                Database connection
              </button>
              <button className="dql-home-secondary-btn" onClick={openSemanticBlock}>
                <Blocks size={15} strokeWidth={2} aria-hidden="true" />
                Build block
              </button>
            </div>
          </div>

          <div className="dql-home-readiness" style={{ borderColor: t.cellBorder, background: t.inputBg }}>
            <div className="dql-home-readiness-head">
              <span style={{ color: t.textMuted }}>Project readiness</span>
              <strong style={{ color: t.textPrimary }}>{readyCount}/4 ready</strong>
            </div>
            <div className="dql-home-meter" aria-label={`${readyCount} of 4 setup steps ready`}>
              {steps.map((step) => (
                <span
                  key={step.id}
                  className={`dql-home-meter-segment is-${step.state}`}
                  title={step.title}
                />
              ))}
            </div>
            <div className="dql-home-readiness-grid">
              <ReadinessItem label="Source context" value={sourceReady ? 'Ready' : 'Needs setup'} state={sourceReady ? 'ready' : 'active'} t={t} />
              <ReadinessItem label="Database" value={connectionReady ? 'Connected' : 'Not tested'} state={connectionReady ? 'ready' : 'active'} t={t} />
              <ReadinessItem label="DQL blocks" value={`${counts.blocks}`} state={dqlReady ? 'ready' : 'waiting'} t={t} />
              <ReadinessItem label="Apps" value={`${state.apps.length}`} state={appReady ? 'ready' : 'waiting'} t={t} />
            </div>
          </div>
        </section>

        <section className="dql-home-steps" aria-label="DQL setup steps">
          {steps.map((step) => (
            <StepCard key={step.id} step={step} t={t} />
          ))}
        </section>

        <section className="dql-home-context-grid">
          <ContextPanel
            title="Source objects from dbt and semantic imports"
            description="Use these as trusted inputs when composing DQL blocks."
            Icon={GitBranch}
            t={t}
            rows={[
              ['dbt project', dbtStatus?.projectName ?? (dbtStatus?.configured ? 'Configured' : 'Not detected')],
              ['manifest.json', artifactLabel(dbtStatus?.artifacts.manifest)],
              ['semantic_manifest.json', artifactLabel(dbtStatus?.artifacts.semanticManifest)],
              ['Semantic models', String(sourceCounts.models)],
              ['Metrics', String(sourceCounts.metrics)],
              ['Measures', String(semanticCounts.measures)],
              ['Dimensions', String(sourceCounts.dimensions)],
            ]}
            actionLabel="Connect or refresh"
            onAction={() => setSetupWizardOpen(true)}
          />
          <ContextPanel
            title="Database catalog and access"
            description="Connection status and schema determine whether blocks can run."
            Icon={Database}
            t={t}
            rows={[
              ['Default connection', connections?.default ?? 'Unknown'],
              ['Connection profiles', String(connectionCount)],
              ['dbt profile targets', String(dbtProfileCount)],
              ['Schemas', String(schemaCounts.schemas)],
              ['Tables', String(schemaCounts.tables)],
              ['Columns', String(schemaCounts.columns)],
            ]}
            actionLabel="Open connections"
            onAction={() => openPanel('connection')}
          />
          <ContextPanel
            title="DQL authoring inventory"
            description="Reviewed files are versioned artifacts that can move into notebooks and Apps."
            Icon={FileJson}
            t={t}
            rows={[
              ['Blocks', String(counts.blocks)],
              ['Business terms', String(counts.terms)],
              ['Business views', String(counts.businessViews)],
              ['Notebooks', String(counts.notebooks)],
              ['Apps', String(state.apps.length)],
            ]}
            actionLabel="Open Block Studio"
            onAction={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'block_studio' })}
          />
        </section>

        <section className="dql-home-bottom">
          <div className="dql-home-artifacts" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
            <div>
              <h2 style={{ color: t.textPrimary }}>What each setup step creates</h2>
              <p style={{ color: t.textSecondary }}>
                The Home page tracks concrete project artifacts so new users know what to do next.
              </p>
            </div>
            <div className="dql-home-artifact-list">
              {ARTIFACTS.map(([name, description]) => (
                <div key={name} className="dql-home-artifact-row" style={{ borderColor: t.cellBorder }}>
                  <code style={{ color: t.textPrimary }}>{name}</code>
                  <span style={{ color: t.textSecondary }}>{description}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="dql-home-next" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
            <h2 style={{ color: t.textPrimary }}>Recommended next action</h2>
            <p style={{ color: t.textSecondary }}>{nextActionCopy(currentStep)}</p>
            <button className="dql-home-link-btn" onClick={steps.find((step) => step.id === currentStep)?.onPrimary}>
              {steps.find((step) => step.id === currentStep)?.primaryLabel ?? 'Continue setup'}
              <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </section>
      </main>

      {setupWizardOpen && (
        <SetupWizard
          detectedProvider={state.semanticLayer.provider}
          onClose={() => setSetupWizardOpen(false)}
          onImported={() => void refreshAfterSemanticImport()}
        />
      )}
    </div>
  );
}

function StepCard({ step, t }: { step: WorkflowStep; t: Theme }) {
  const Icon = step.Icon;
  return (
    <article
      className={`dql-home-step is-${step.state}`}
      style={{ borderColor: step.state === 'active' ? t.accent : t.cellBorder, background: t.cellBg }}
    >
      <div className="dql-home-step-top">
        <span className={`dql-home-step-number is-${step.state}`}>{step.number}</span>
        <Icon size={18} strokeWidth={2} color={step.state === 'ready' ? 'var(--color-accent-green)' : step.state === 'active' ? t.accent : t.textMuted} aria-hidden="true" />
        <span className={`dql-home-status is-${step.state}`}>{statusLabel(step.state)}</span>
      </div>
      <h2 style={{ color: t.textPrimary }}>{step.title}</h2>
      <p style={{ color: t.textSecondary }}>{step.body}</p>
      <div className="dql-home-evidence">
        {step.evidence.map((item) => (
          <span key={item} style={{ borderColor: t.cellBorder, color: t.textMuted }}>{item}</span>
        ))}
      </div>
      <div className="dql-home-card-actions">
        <button className="dql-home-primary-btn dql-home-card-btn" onClick={step.onPrimary}>
          {step.primaryLabel}
        </button>
        {step.secondaryLabel && step.onSecondary && (
          <button className="dql-home-secondary-btn dql-home-card-btn" onClick={step.onSecondary}>
            {step.secondaryLabel}
          </button>
        )}
      </div>
    </article>
  );
}

function ReadinessItem({
  label,
  value,
  state,
  t,
}: {
  label: string;
  value: string;
  state: StepState;
  t: Theme;
}) {
  return (
    <div className="dql-home-readiness-item" style={{ borderColor: t.cellBorder }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <strong className={`is-${state}`} style={{ color: state === 'ready' ? 'var(--color-accent-green)' : state === 'active' ? t.accent : t.textPrimary }}>
        {value}
      </strong>
    </div>
  );
}

function ContextPanel({
  title,
  description,
  Icon,
  rows,
  actionLabel,
  onAction,
  t,
}: {
  title: string;
  description: string;
  Icon: LucideIcon;
  rows: Array<[string, string]>;
  actionLabel: string;
  onAction: () => void;
  t: Theme;
}) {
  return (
    <section className="dql-home-context-panel" style={{ borderColor: t.cellBorder, background: t.cellBg }}>
      <div className="dql-home-context-head">
        <div className="dql-home-context-icon" style={{ background: `${t.accent}18`, color: t.accent }}>
          <Icon size={18} strokeWidth={2} aria-hidden="true" />
        </div>
        <div>
          <h2 style={{ color: t.textPrimary }}>{title}</h2>
          <p style={{ color: t.textSecondary }}>{description}</p>
        </div>
      </div>
      <div className="dql-home-context-rows">
        {rows.map(([label, value]) => (
          <div key={label} className="dql-home-context-row" style={{ borderColor: t.cellBorder }}>
            <span style={{ color: t.textMuted }}>{label}</span>
            <strong style={{ color: t.textPrimary }}>{value}</strong>
          </div>
        ))}
      </div>
      <button className="dql-home-link-btn" onClick={onAction}>
        {actionLabel}
        <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
      </button>
    </section>
  );
}

function statusLabel(state: StepState): string {
  if (state === 'ready') return 'Ready';
  if (state === 'active') return 'Next';
  return 'Waiting';
}

function nextActionCopy(currentStep: string): string {
  if (currentStep === 'source') {
    return 'Connect a dbt project or semantic source first. DQL needs source context before it can recommend useful blocks and lineage.';
  }
  if (currentStep === 'connection') {
    return 'Add a database connection and test it. This confirms DQL can execute the blocks created from your source context.';
  }
  if (currentStep === 'build') {
    return 'Create the first reviewed DQL block from a semantic metric, dbt model, table, or imported SQL file.';
  }
  return 'Open a notebook, assemble the reviewed blocks, and publish the answer into an App when it is ready for others.';
}

function artifactLabel(artifact?: { exists: boolean; count?: number }): string {
  if (!artifact) return 'Unknown';
  if (!artifact.exists) return 'Missing';
  return typeof artifact.count === 'number' ? `Ready (${artifact.count})` : 'Ready';
}

function countFiles(files: NotebookFile[]) {
  return files.reduce(
    (acc, file) => {
      if (file.type === 'block') acc.blocks += 1;
      else if (file.type === 'term') acc.terms += 1;
      else if (file.type === 'business_view') acc.businessViews += 1;
      else if (file.type === 'notebook' || file.type === 'workbook') acc.notebooks += 1;
      return acc;
    },
    { notebooks: 0, blocks: 0, terms: 0, businessViews: 0 },
  );
}

function countSemanticObjects(layer: SemanticLayerState) {
  const metrics = layer.metrics.length;
  const measures = layer.measures.length;
  const dimensions = layer.dimensions.length + layer.timeDimensions.length;
  const models = layer.semanticModels.length;
  const savedQueries = layer.savedQueries.length;
  return {
    metrics,
    measures,
    dimensions,
    models,
    savedQueries,
    total: metrics + measures + dimensions + models + savedQueries + layer.entities.length + layer.hierarchies.length,
  };
}

function countSchema(tables: Array<{ name: string; columns: unknown[] }>) {
  const schemas = new Set<string>();
  let columns = 0;
  for (const table of tables) {
    const [schema, ...rest] = table.name.split('.');
    schemas.add(rest.length > 0 ? schema : 'default');
    columns += table.columns.length;
  }
  return { schemas: schemas.size, tables: tables.length, columns };
}

const HOME_PAGE_STYLES = `
.dql-home-page {
  width: min(1220px, calc(100% - 48px));
  margin: 0 auto;
  padding: 24px 0 44px;
}

.dql-home-hero {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(360px, 0.82fr);
  gap: 18px;
  align-items: stretch;
  border: 1px solid;
  border-radius: 8px;
  padding: 22px;
}

.dql-home-hero-copy,
.dql-home-readiness,
.dql-home-context-panel,
.dql-home-artifacts,
.dql-home-next {
  min-width: 0;
}

.dql-home-hero-copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
}

.dql-home-brand-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.dql-home-logo {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  background: var(--color-accent-blue);
  color: var(--accent-on, #fff);
  font-weight: 900;
  font-family: var(--font-mono);
}

.dql-home-hero h1 {
  margin: 0;
  max-width: 720px;
  font-size: 44px;
  line-height: 1.02;
  font-weight: 900;
  letter-spacing: 0;
  overflow-wrap: break-word;
}

.dql-home-lead {
  max-width: 720px;
  margin: 0;
  font-size: 15px;
  line-height: 1.55;
}

.dql-home-cta-row,
.dql-home-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.dql-home-primary-btn,
.dql-home-secondary-btn,
.dql-home-link-btn {
  min-height: 34px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--color-border-primary);
  font: 800 12px var(--font-ui);
  cursor: pointer;
  max-width: 100%;
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
}

.dql-home-primary-btn {
  background: var(--color-accent-blue);
  color: var(--accent-on, #fff);
  border-color: var(--color-accent-blue);
}

.dql-home-secondary-btn,
.dql-home-link-btn {
  background: var(--color-bg-sunken);
  color: var(--color-text-secondary);
}

.dql-home-primary-btn:hover,
.dql-home-secondary-btn:hover,
.dql-home-link-btn:hover {
  transform: translateY(-1px);
  border-color: var(--color-accent-blue);
}

.dql-home-readiness {
  border: 1px solid;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dql-home-readiness-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  font-weight: 900;
  text-transform: uppercase;
}

.dql-home-meter {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.dql-home-meter-segment {
  height: 8px;
  border-radius: 999px;
  background: var(--color-border-secondary);
}

.dql-home-meter-segment.is-ready {
  background: var(--color-accent-green);
}

.dql-home-meter-segment.is-active {
  background: var(--color-accent-blue);
}

.dql-home-readiness-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.dql-home-readiness-item {
  border: 1px solid;
  border-radius: 7px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dql-home-readiness-item span {
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}

.dql-home-readiness-item strong {
  font-size: 15px;
  line-height: 1.1;
}

.dql-home-steps {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.dql-home-step {
  border: 1px solid;
  border-radius: 8px;
  padding: 14px;
  min-height: 286px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dql-home-step.is-active {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent-blue) 22%, transparent);
}

.dql-home-step-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dql-home-step-number {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 900 12px var(--font-mono);
  background: var(--color-bg-sunken);
  color: var(--color-text-secondary);
}

.dql-home-step-number.is-ready {
  background: color-mix(in srgb, var(--color-accent-green) 18%, transparent);
  color: var(--color-accent-green);
}

.dql-home-step-number.is-active {
  background: color-mix(in srgb, var(--color-accent-blue) 18%, transparent);
  color: var(--color-accent-blue);
}

.dql-home-status {
  margin-left: auto;
  font: 900 10px var(--font-ui);
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}

.dql-home-status.is-ready {
  color: var(--color-accent-green);
}

.dql-home-status.is-active {
  color: var(--color-accent-blue);
}

.dql-home-step h2,
.dql-home-context-panel h2,
.dql-home-artifacts h2,
.dql-home-next h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.2;
}

.dql-home-step p,
.dql-home-context-panel p,
.dql-home-artifacts p,
.dql-home-next p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.dql-home-evidence {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: auto;
}

.dql-home-evidence span {
  border: 1px solid;
  border-radius: 6px;
  padding: 6px 8px;
  font: 800 11px var(--font-ui);
}

.dql-home-card-btn {
  flex: 1 1 120px;
}

.dql-home-context-grid {
  margin-top: 14px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.dql-home-context-panel {
  border: 1px solid;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dql-home-context-head {
  display: grid;
  grid-template-columns: 34px 1fr;
  gap: 10px;
  align-items: start;
}

.dql-home-context-icon {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.dql-home-context-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dql-home-context-row {
  min-height: 32px;
  border-bottom: 1px solid;
  display: grid;
  grid-template-columns: minmax(110px, 1fr) auto;
  gap: 10px;
  align-items: center;
  font-size: 12px;
}

.dql-home-context-row:last-child {
  border-bottom: none;
}

.dql-home-context-row strong {
  font-family: var(--font-mono);
  font-size: 12px;
}

.dql-home-bottom {
  margin-top: 14px;
  display: grid;
  grid-template-columns: minmax(520px, 1fr) minmax(320px, 0.45fr);
  gap: 12px;
}

.dql-home-artifacts,
.dql-home-next {
  border: 1px solid;
  border-radius: 8px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dql-home-artifact-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.dql-home-artifact-row {
  border: 1px solid;
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dql-home-artifact-row code {
  font: 800 12px var(--font-mono);
}

.dql-home-artifact-row span {
  font-size: 12px;
  line-height: 1.35;
}

@media (max-width: 1120px) {
  .dql-home-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dql-home-context-grid,
  .dql-home-bottom,
  .dql-home-hero {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .dql-home-page {
    width: min(100% - 16px, 560px);
    padding-top: 16px;
  }

  .dql-home-hero {
    padding: 14px;
  }

  .dql-home-hero h1 {
    font-size: 30px;
  }

  .dql-home-steps,
  .dql-home-readiness-grid,
  .dql-home-artifact-list {
    grid-template-columns: 1fr;
  }
}
`;
