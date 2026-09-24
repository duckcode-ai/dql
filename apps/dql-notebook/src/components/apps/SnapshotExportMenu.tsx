import { useEffect, useRef, useState } from 'react';
import { Download, FileCheck2, Image as ImageIcon, Printer } from 'lucide-react';

export type SnapshotFormat = 'html' | 'png' | 'pdf';

/**
 * The reader's export menu (RFC 0008 step 10). Every format is built from
 * one signed snapshot of the current run: the HTML file verifies offline,
 * and the image and PDF carry the same proof footer.
 */
export function SnapshotExportMenu({
  disabledReason,
  onExport,
}: {
  /** Why export is not available right now, e.g. while the page is loading. */
  disabledReason?: string | null;
  onExport: (format: SnapshotFormat) => Promise<string>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<SnapshotFormat | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  // A success note fades on its own; an error stays until the next action.
  useEffect(() => {
    if (status?.tone !== 'ok') return;
    const timer = window.setTimeout(() => setStatus(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [status]);
  const run = async (format: SnapshotFormat) => {
    setOpen(false);
    setBusy(format);
    setStatus(null);
    try {
      setStatus({ tone: 'ok', text: await onExport(format) });
    } catch (cause) {
      setStatus({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(null);
    }
  };
  const options: Array<{ format: SnapshotFormat; label: string; detail: string; icon: JSX.Element }> = [
    { format: 'html', label: 'Signed HTML', detail: 'One file anyone can check offline', icon: <FileCheck2 size={14} aria-hidden="true" /> },
    { format: 'png', label: 'PNG image', detail: 'For slides and chat', icon: <ImageIcon size={14} aria-hidden="true" /> },
    { format: 'pdf', label: 'Print or save as PDF', detail: 'Opens the print dialog', icon: <Printer size={14} aria-hidden="true" /> },
  ];
  return (
    <div className="dql-export" ref={rootRef}>
      <button
        type="button"
        className="dql-export-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={Boolean(disabledReason) || busy !== null}
        title={disabledReason ?? 'Export this page as it is now'}
        onClick={() => { setStatus(null); setOpen((current) => !current); }}
      >
        <Download size={13} aria-hidden="true" /> {busy ? 'Exporting…' : 'Export'}
      </button>
      {open ? (
        <div className="dql-export-menu" role="menu" aria-label="Export this page">
          {options.map((option) => (
            <button key={option.format} type="button" role="menuitem" onClick={() => void run(option.format)}>
              {option.icon}
              <span><strong>{option.label}</strong><small>{option.detail}</small></span>
            </button>
          ))}
        </div>
      ) : null}
      {status ? <span className={`dql-export-status ${status.tone}`} role={status.tone === 'error' ? 'alert' : 'status'}>{status.text}</span> : null}
    </div>
  );
}
