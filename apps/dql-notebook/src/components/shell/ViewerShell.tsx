import { useEffect } from 'react';
import { useNotebookStore } from '../../store/NotebookStore';
import { viewerLink } from '../../api/server-auth';
import { readAppPageLink } from '../apps/app-links';
import { AppsView } from '../apps/AppsView';

/**
 * The whole UI for a read-only page link (RFC 0010): the one App the link
 * names, in the reader, with no workspace around it — no notebooks, Studio,
 * settings or other Apps. The server enforces the same limits; this keeps
 * the page from offering what the link cannot do.
 */
export function ViewerShell(): JSX.Element {
  const link = viewerLink();
  const dispatch = useNotebookStore((state) => state.dispatch);
  const activeAppId = useNotebookStore((state) => state.activeAppId);
  useEffect(() => {
    if (!link) return;
    const page = readAppPageLink(window.location.href);
    const pageId = page?.appId === link.appId ? page.pageId : undefined;
    dispatch({ type: 'OPEN_APP', appId: link.appId, ...(pageId ? { dashboardId: pageId } : {}), experience: 'view', section: 'dashboards' });
  }, [dispatch, link?.appId]);

  if (!link) return <></>;
  const expires = new Date(link.expiresAt);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg-primary)' }}>
      <main style={{ flex: 1, minHeight: 0, overflow: 'auto' }} aria-label="Shared App">
        {activeAppId === link.appId ? <AppsView /> : null}
      </main>
      <footer style={{ padding: '6px 16px', fontSize: 11, color: 'var(--color-text-tertiary)', borderTop: '1px solid var(--color-border-primary)' }}>
        Read-only link to this App{Number.isNaN(expires.getTime()) ? '' : `, until ${expires.toLocaleDateString()}`}.
      </footer>
    </div>
  );
}
