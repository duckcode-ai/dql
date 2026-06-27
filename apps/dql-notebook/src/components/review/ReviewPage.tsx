// Review & Certify queue — the surface the Get Started "Approve & Generate"
// flow (and the "Open review queue" button) route into. It lists the DRAFT /
// in-review governance blocks (what `dql propose` generated), NOT Apps — each
// row opens that block in Block Studio to preview, edit, run tests, and certify.
// Nothing here certifies automatically; promotion is a per-block human action.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { api } from '../../api/client';
import { useNotebook } from '../../store/NotebookStore';
import { TrustBadge, type TrustState } from '@duckcodeailabs/dql-ui';

interface LibraryBlock {
  name: string;
  domain: string;
  status: string;
  owner: string | null;
  tags: string[];
  path: string;
  lastModified: string;
  description: string;
}

export function ReviewPage(): JSX.Element {
  const { state, dispatch } = useNotebook();
  const [blocks, setBlocks] = useState<LibraryBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [openError, setOpenError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void api.getBlockLibrary().then((result) => {
      if (cancelled) return;
      setBlocks(result.blocks);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  const counts = useMemo(() => {
    const c = { draft: 0, review: 0, certified: 0 };
    for (const b of blocks) {
      if (b.status === 'draft') c.draft += 1;
      else if (b.status === 'review') c.review += 1;
      else if (b.status === 'certified') c.certified += 1;
    }
    return c;
  }, [blocks]);

  // Blocks that still need a human: drafts (incl. AI-generated) + in-review.
  const reviewItems = useMemo(
    () =>
      blocks
        .filter((b) => b.status === 'draft' || b.status === 'review')
        .sort((a, b) => statusWeight(b.status) - statusWeight(a.status) || a.name.localeCompare(b.name)),
    [blocks],
  );

  const openInStudio = useCallback(async (block: LibraryBlock) => {
    setOpenError(null);
    setBusyPath(block.path);
    try {
      const file = {
        name: block.path.split('/').pop() ?? `${block.name}.dql`,
        path: block.path,
        type: 'block' as const,
        folder: 'blocks',
      };
      if (!state.files.some((f) => f.path === block.path)) {
        dispatch({ type: 'FILE_ADDED', file });
      }
      const payload = await api.openBlockStudio(block.path);
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
    } catch (error) {
      setOpenError(
        `Could not open "${block.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusyPath(null);
    }
  }, [dispatch, state.files]);

  return (
    <div style={{ padding: 20, display: 'grid', gap: 14, maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ fontSize: 18, fontWeight: 750 }}>Review &amp; Certify</div>
        <div style={{ fontSize: 13, opacity: 0.7 }}>
          Draft governance blocks waiting for a human. Open one to preview results, edit metadata,
          run tests, and certify. Nothing is certified automatically.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        <ReviewStat label="Drafts to review" value={counts.draft} tone="draft" />
        <ReviewStat label="In review" value={counts.review} tone="review" />
        <ReviewStat label="Certified" value={counts.certified} tone="certified" />
      </div>

      {openError ? <div style={{ ...emptyStyle, borderColor: 'var(--status-error, #cf222e)' }}>{openError}</div> : null}

      <div style={{ display: 'grid', gap: 8 }}>
        {loading ? (
          <div style={emptyStyle}>Loading review queue…</div>
        ) : reviewItems.length === 0 ? (
          <div style={{ ...emptyStyle, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={16} />
            <span>
              No draft blocks waiting. Generate a business-focused seed from{' '}
              <button type="button" onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'readiness' })} style={linkBtnStyle}>
                Get Started
              </button>
              .
            </span>
          </div>
        ) : (
          reviewItems.map((block) => (
            <ReviewBlockRow
              key={block.path}
              block={block}
              busy={busyPath === block.path}
              onOpen={() => void openInStudio(block)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ReviewBlockRow({ block, busy, onOpen }: { block: LibraryBlock; busy: boolean; onOpen: () => void }) {
  const trustState: TrustState = block.status === 'certified' ? 'certified' : block.status === 'review' ? 'review' : 'draft';
  return (
    <div style={{ ...rowStyle, borderLeftColor: trustAccent(trustState) }}>
      <div style={{ display: 'grid', gap: 5, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 750 }}>{block.name}</span>
          <TrustBadge state={trustState} />
          {block.domain ? <Pill>{block.domain}</Pill> : null}
        </div>
        {block.description ? (
          <div style={{ fontSize: 12, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {block.description}
          </div>
        ) : null}
        <div style={{ fontSize: 11, opacity: 0.55 }}>{block.owner ? `owner ${block.owner}` : 'no owner yet'}</div>
      </div>
      <button type="button" onClick={onOpen} disabled={busy} style={{ ...reviewBtnStyle, opacity: busy ? 0.6 : 1, cursor: busy ? 'progress' : 'pointer' }}>
        {busy ? 'Opening…' : <>Review &amp; Certify <ArrowRight size={13} /></>}
      </button>
    </div>
  );
}

function ReviewStat({ label, value, tone }: { label: string; value: number; tone: TrustState }) {
  return (
    <div style={{ ...statStyle, borderTop: `2px solid ${trustAccent(tone)}` }}>
      <div style={{ fontSize: 11, opacity: 0.62 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function Pill({ children }: { children: string }) {
  return <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'var(--surface-hover, rgba(0,0,0,0.06))', opacity: 0.82 }}>{children}</span>;
}

function statusWeight(status: string): number {
  return status === 'review' ? 2 : status === 'draft' ? 1 : 0;
}

function trustAccent(state: TrustState): string {
  if (state === 'certified') return 'var(--status-success, #1f883d)';
  if (state === 'no_answer') return 'var(--status-error, #cf222e)';
  if (state === 'deprecated') return 'var(--text-tertiary, #8a8d96)';
  return 'var(--status-warning, #9a6700)';
}

const rowStyle: CSSProperties = {
  width: '100%',
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderLeft: '3px solid var(--status-warning, #9a6700)',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  color: 'inherit',
  padding: 12,
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 12,
  alignItems: 'center',
};

const statStyle: CSSProperties = {
  border: '1px solid var(--border-color, rgba(0,0,0,0.10))',
  borderRadius: 7,
  background: 'var(--surface, rgba(0,0,0,0.02))',
  padding: 12,
};

const reviewBtnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '7px 12px',
  borderRadius: 6,
  border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
  background: 'var(--surface, transparent)',
  color: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const linkBtnStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--accent, #0969da)',
  font: 'inherit',
  cursor: 'pointer',
  textDecoration: 'underline',
};

const emptyStyle: CSSProperties = {
  border: '1px dashed var(--border-color, rgba(0,0,0,0.16))',
  borderRadius: 8,
  padding: 24,
  fontSize: 13,
  opacity: 0.8,
};
