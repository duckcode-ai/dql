import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { postDqlCloudEvent } from '../../cloud/cloud-mode';
import { useNotebook } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { serializeDqlNotebook } from '../../utils/parse-workbook';

export function CloudWorkbenchToolbar() {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2600);
  }, []);

  const serializedNotebookContent = useCallback(() => (
    serializeDqlNotebook(state.notebookTitle, state.cells, state.notebookMetadata)
  ), [state.cells, state.notebookMetadata, state.notebookTitle]);

  const requestId = useCallback(() => (
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  ), []);

  const handleSave = useCallback(async () => {
    if (!state.activeFile) {
      dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' });
      return;
    }
    setSaving(true);
    dispatch({ type: 'SET_SAVING', saving: true });
    try {
      const content = state.activeFile.type === 'block'
        ? (state.cells[0]?.content ?? '')
        : serializedNotebookContent();
      await api.saveNotebook(state.activeFile.path, content);
      dispatch({ type: 'SET_NOTEBOOK_DIRTY', dirty: false });
      postDqlCloudEvent('dql.artifact.saved', {
        path: state.activeFile.path,
        kind: state.activeFile.type,
      });
      if (state.activeFile.type === 'notebook') {
        postDqlCloudEvent('dql.notebook.saved', {
          request_id: requestId(),
          name: state.notebookTitle || state.activeFile.name,
          path: state.activeFile.path,
          content,
          visibility: 'private',
          description: state.notebookMetadata.description,
        });
      }
      showNotice('Saved');
    } catch (error) {
      console.error('Cloud workbench save failed:', error);
      showNotice('Save failed');
    } finally {
      dispatch({ type: 'SET_SAVING', saving: false });
      setSaving(false);
    }
  }, [
    dispatch,
    showNotice,
    state.activeFile,
    state.cells,
    serializedNotebookContent,
    requestId,
  ]);

  const handleShareNotebook = useCallback(async () => {
    if (!state.activeFile || state.activeFile.type !== 'notebook') {
      showNotice('Open a notebook first');
      return;
    }
    setSharing(true);
    dispatch({ type: 'SET_SAVING', saving: true });
    try {
      const content = serializedNotebookContent();
      await api.saveNotebook(state.activeFile.path, content);
      dispatch({ type: 'SET_NOTEBOOK_DIRTY', dirty: false });
      const shareRequestId = requestId();
      postDqlCloudEvent('dql.notebook.share', {
        request_id: shareRequestId,
        name: state.notebookTitle || state.activeFile.name,
        path: state.activeFile.path,
        content,
        visibility: 'shared',
        description: state.notebookMetadata.description,
      });
      showNotice('Sharing with project…');
    } catch (error) {
      console.error('Cloud notebook share failed:', error);
      showNotice('Share failed');
    } finally {
      dispatch({ type: 'SET_SAVING', saving: false });
      setSharing(false);
    }
  }, [
    dispatch,
    serializedNotebookContent,
    requestId,
    showNotice,
    state.activeFile,
    state.notebookMetadata.description,
    state.notebookTitle,
  ]);

  const handleCreateNotebook = useCallback(async () => {
    dispatch({ type: 'OPEN_NEW_NOTEBOOK_MODAL' });
  }, [dispatch]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; error?: string };
      if (data?.type === 'dql.cell.submit_for_certify.ack') showNotice('Proposal created');
      if (data?.type === 'dql.cell.submit_for_certify.nack') showNotice(data.error ?? 'Submit failed');
      if (data?.type === 'dql.notebook.saved.ack') showNotice('Private notebook saved. Submit a cell for review when ready.');
      if (data?.type === 'dql.notebook.saved.nack') showNotice(data.error ?? 'Save failed');
      if (data?.type === 'dql.notebook.share.ack') showNotice('Shared with project');
      if (data?.type === 'dql.notebook.share.nack') showNotice(data.error ?? 'Share failed');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [showNotice]);

  const buttonStyle: React.CSSProperties = {
    height: 30,
    borderRadius: 6,
    border: `1px solid ${t.btnBorder}`,
    background: '#ffffff',
    color: t.textSecondary,
    fontFamily: t.font,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 10px',
    whiteSpace: 'nowrap',
  };
  const subtleGroupStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: 4,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 8,
    background: '#ffffff',
    whiteSpace: 'nowrap',
  };

  return (
    <>
      <div
        data-cloud-workbench-toolbar="true"
        style={{
          minHeight: 46,
          flexShrink: 0,
          borderBottom: `1px solid ${t.headerBorder}`,
          background: '#ffffff',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          boxSizing: 'border-box',
          overflowX: 'auto',
        }}
      >
        <button style={buttonStyle} onClick={() => void handleCreateNotebook()}>New notebook</button>
        <span
          title="Private notebooks are only visible to you and admins until shared."
          style={{
            height: 30,
            borderRadius: 999,
            border: `1px solid ${t.btnBorder}`,
            background: '#ffffff',
            color: t.textMuted,
            fontFamily: t.font,
            fontSize: 11,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            whiteSpace: 'nowrap',
          }}
        >
          Private draft
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            title={state.notebookTitle || state.activeFile?.name || 'Untitled notebook'}
            style={{
              color: t.textPrimary,
              fontFamily: t.font,
              fontSize: 13,
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {state.notebookTitle || state.activeFile?.name || 'Untitled notebook'}
          </div>
          <div style={{ color: t.textMuted, fontFamily: t.font, fontSize: 11 }}>
            Use cell controls to add SQL, run, validate, create blocks, and inspect lineage.
          </div>
        </div>
        <div style={subtleGroupStyle}>
          <button style={buttonStyle} onClick={() => void handleSave()} disabled={saving || state.savingFile}>
            {saving || state.savingFile ? 'Saving…' : 'Save private'}
          </button>
          <button
            style={{ ...buttonStyle, borderColor: '#fdba74', background: '#fff7ed', color: '#c2410c' }}
            onClick={() => void handleShareNotebook()}
            disabled={!state.activeFile || state.activeFile.type !== 'notebook' || sharing}
            title="Save this notebook and make it visible in Cloud Shared notebooks and App notebook pickers"
          >
            {sharing ? 'Sharing…' : 'Share'}
          </button>
        </div>
        {notice && <span style={{ color: t.textMuted, fontSize: 12, fontFamily: t.font }}>{notice}</span>}
      </div>
    </>
  );
}
