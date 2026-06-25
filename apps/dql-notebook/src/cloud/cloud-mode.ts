export type CloudContextTab = 'notebooks' | 'semantic' | 'schema' | 'contracts' | 'lineage' | 'blocks';

export type DqlCloudRoute =
  | { kind: 'workbench' }
  | { kind: 'apps' }
  | { kind: 'notebook'; path: string; name?: string | null }
  | { kind: 'lineage'; focus?: string | null; focusType?: string | null; focusKey?: string | null }
  | { kind: 'block'; path: string; name?: string | null }
  | { kind: 'object'; objectType: string; objectKey: string; label?: string | null };

export interface DqlCloudEmbedConfig {
  cloud?: boolean;
  kind?: 'dql' | string;
  surface?: 'build' | string;
  tenant_id?: string;
  project_id?: string;
  role?: string;
  capabilities?: {
    layout?: string;
    hide_activity_bar?: boolean;
    hide_sidebar?: boolean;
    primary_authoring_surface?: string;
    block_studio_mode?: string;
  };
  repo_context?: {
    repo_url?: string | null;
    default_branch?: string | null;
    dbt_subfolder?: string | null;
    datalex_subfolder?: string | null;
    dql_subfolder?: string | null;
  };
  warehouse_context?: {
    warehouse_kind?: string | null;
    warehouse_configured?: boolean;
    business_domain?: string | null;
    semantic_manifest_path?: string | null;
  };
}

declare global {
  interface Window {
    __DATALEX_CLOUD_EMBED__?: DqlCloudEmbedConfig;
  }
}

function getParams(): URLSearchParams | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search);
}

export function getCloudEmbedConfig(): DqlCloudEmbedConfig | null {
  if (typeof window === 'undefined') return null;
  return window.__DATALEX_CLOUD_EMBED__ ?? null;
}

export function isDqlCloudBuildMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = getParams();
  const config = getCloudEmbedConfig();
  const root = document.documentElement;
  const queryCloud = params?.get('cloud') === '1';
  const querySurface = params?.get('surface') === 'build';
  const queryEmbeddedBuild = params?.get('embedded') === '1' && querySurface;
  const injectedCloud =
    root.dataset.datalexCloudKind === 'dql' &&
    root.dataset.datalexCloudSurface === 'build';
  const configCloud = config?.kind === 'dql' && config?.surface === 'build';
  return (queryCloud && querySurface) || queryEmbeddedBuild || injectedCloud || configCloud;
}

export function isDqlCloudMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = getParams();
  const config = getCloudEmbedConfig();
  const root = document.documentElement;
  return (
    (params?.get('cloud') === '1' && (params?.get('surface') === 'build' || params?.get('surface') === 'govern')) ||
    (params?.get('embedded') === '1' && params?.get('surface') === 'build') ||
    root.dataset.datalexCloudKind === 'dql' ||
    config?.kind === 'dql'
  );
}

export function getDqlCloudRoute(): DqlCloudRoute {
  if (typeof window === 'undefined') return { kind: 'workbench' };
  const raw = window.location.hash.replace(/^#/, '') || '/notebooks';
  const [pathname, query = ''] = raw.split('?');
  if (pathname === '/apps') {
    return { kind: 'apps' };
  }
  if (pathname === '/lineage') {
    const params = new URLSearchParams(query);
    return {
      kind: 'lineage',
      focus: params.get('focus'),
      focusType: params.get('focus_type'),
      focusKey: params.get('focus_key'),
    };
  }
  if (pathname === '/notebooks/open') {
    const params = new URLSearchParams(query);
    return {
      kind: 'notebook',
      path: params.get('path') ?? '',
      name: params.get('name'),
    };
  }
  if (pathname === '/blocks/view') {
    const params = new URLSearchParams(query);
    return {
      kind: 'block',
      path: params.get('path') ?? '',
      name: params.get('name'),
    };
  }
  if (pathname === '/objects/view') {
    const params = new URLSearchParams(query);
    return {
      kind: 'object',
      objectType: params.get('type') ?? 'object',
      objectKey: params.get('key') ?? '',
      label: params.get('label'),
    };
  }
  return { kind: 'workbench' };
}

export function openCloudObjectDetail(input: {
  objectType: string;
  objectKey: string;
  label?: string | null;
}) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams({
    type: input.objectType,
    key: input.objectKey,
  });
  if (input.label) params.set('label', input.label);
  window.location.hash = `/objects/view?${params.toString()}`;
  postDqlCloudEvent('dql.object.open_detail', {
    object_type: input.objectType,
    object_key: input.objectKey,
    label: input.label ?? input.objectKey,
  });
}

export function openCloudLineage(input: {
  objectType?: string | null;
  objectKey?: string | null;
  label?: string | null;
}) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (input.objectType) params.set('focus_type', input.objectType);
  if (input.objectKey) params.set('focus_key', input.objectKey);
  if (input.label) params.set('focus', input.label);
  window.location.hash = `/lineage${params.toString() ? `?${params.toString()}` : ''}`;
  postDqlCloudEvent('dql.object.show_lineage', {
    object_type: input.objectType,
    object_key: input.objectKey,
    label: input.label,
  });
}

export function postDqlCloudEvent(type: string, payload: Record<string, unknown> = {}) {
  if (typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage({ type, payload }, '*');
}

export function listenForCloudContext(handler: (config: DqlCloudEmbedConfig) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; config?: DqlCloudEmbedConfig };
    if (data?.type === 'dql.cloud.context' && data.config) {
      window.__DATALEX_CLOUD_EMBED__ = data.config;
      handler(data.config);
    }
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
