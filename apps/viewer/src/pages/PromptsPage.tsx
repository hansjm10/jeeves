import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { decodePathPreservingSlashes, encodePathPreservingSlashes } from '../api/paths.js';
import { useViewerServerBaseUrl } from '../app/ViewerServerProvider.js';
import { useSavePromptMutation } from '../features/mutations.js';
import { usePromptListQuery, usePromptQuery } from '../features/prompts/queries.js';
import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { useToast } from '../ui/toast/ToastProvider.js';
import { useUnsavedChanges } from '../ui/unsaved/UnsavedChangesProvider.js';

function promptRoutePath(id: string): string {
  const encoded = encodePathPreservingSlashes(id);
  return `/prompts/${encoded}`;
}

function usePromptIdFromRoute(): string | null {
  const params = useParams();
  const raw = (params['*'] ?? '').trim();
  if (!raw) return null;
  try {
    return decodePathPreservingSlashes(raw);
  } catch {
    return raw;
  }
}

export function PromptsPage() {
  const baseUrl = useViewerServerBaseUrl();
  const { pushToast } = useToast();
  const { confirmDiscard, setDirty: setUnsavedDirty } = useUnsavedChanges();
  const navigate = useNavigate();
  const stream = useViewerStream();

  const runRunning = stream.state?.run.running ?? false;

  const promptId = usePromptIdFromRoute();
  const promptListQuery = usePromptListQuery(baseUrl);
  const promptQuery = usePromptQuery(baseUrl, promptId);
  const savePrompt = useSavePromptMutation(baseUrl);

  const [editorValue, setEditorValue] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!promptId) {
      setEditorValue('');
      setDirty(false);
      return;
    }
    setEditorValue('');
    setDirty(false);
  }, [promptId]);

  useEffect(() => {
    const data = promptQuery.data;
    if (!data) return;
    if (dirty) return;
    setEditorValue(data.content);
  }, [dirty, promptQuery.data]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    setUnsavedDirty(dirty);
  }, [dirty, setUnsavedDirty]);

  useEffect(() => {
    return () => setUnsavedDirty(false);
  }, [setUnsavedDirty]);

  const promptIds = useMemo(() => {
    return (promptListQuery.data?.prompts ?? []).map((p) => p.id);
  }, [promptListQuery.data]);

  async function handleSave() {
    if (!promptId) return;
    await savePrompt.mutateAsync({ id: promptId, content: editorValue });
    setDirty(false);
    pushToast(`Saved ${promptId}`);
  }

  async function handleReload() {
    if (!promptId) return;
    await promptQuery.refetch();
    setDirty(false);
  }

  return (
    <div className="panel">
      <div className="panelTitle">Prompts</div>
      <div className="panelBody prompts">
        <div className="promptList">
          <div className="row">
            <button className="btn" onClick={() => void promptListQuery.refetch().catch((e) => pushToast(String(e)))}>
              Refresh
            </button>
          </div>
          {promptListQuery.isLoading ? <div className="muted">Loading prompts…</div> : null}
          {promptListQuery.isError ? <div className="errorBox">{promptListQuery.error instanceof Error ? promptListQuery.error.message : String(promptListQuery.error)}</div> : null}
          {promptIds.map((id) => (
            <button
              key={id}
              className={`listItem ${promptId === id ? 'active' : ''}`}
              onClick={() => {
                if (!confirmDiscard()) return;
                setDirty(false);
                navigate(promptRoutePath(id));
              }}
            >
              <div className="listMain mono">{id}</div>
            </button>
          ))}
        </div>

        <div className="promptEditor">
          <div className="row">
            <div className="muted">{promptId ? <span className="mono">{promptId}</span> : 'Select a prompt'}</div>
            <div className="row">
              <button className="btn" disabled={!promptId} onClick={() => void handleReload().catch((e) => pushToast(String(e)))}>
                Reload
              </button>
              <button className="btn primary" disabled={!promptId || !dirty || runRunning || savePrompt.isPending} onClick={() => void handleSave().catch((e) => pushToast(String(e)))}>
                {savePrompt.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          {promptQuery.isError ? <div className="errorBox">{promptQuery.error instanceof Error ? promptQuery.error.message : String(promptQuery.error)}</div> : null}

          <textarea
            className="textarea"
            value={editorValue}
            onChange={(e) => {
              setEditorValue(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            disabled={!promptId}
          />
        </div>
      </div>
    </div>
  );
}
