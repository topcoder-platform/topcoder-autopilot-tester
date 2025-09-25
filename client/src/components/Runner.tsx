
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { FlowVariant } from '../types'
import { FLOW_DEFINITIONS } from '../flows'

type LogEntry = { level: string; message: string; data?: any; progress?: number };
type ChallengeSnapshot = { id: number; stage?: string; timestamp: string; challenge: any };
type StepName = string;
type StepStatus = 'pending' | 'in-progress' | 'success' | 'failure';
type StepRequestLog = {
  id: string;
  method?: string;
  endpoint?: string;
  status?: number;
  message?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: Record<string, unknown>;
  timestamp?: string;
  durationMs?: number;
  outcome: 'success' | 'failure';
};
type StepEvent = {
  type: 'step';
  step: StepName;
  status: StepStatus;
  requests?: StepRequestLog[];
  failedRequests?: StepRequestLog[];
  timestamp: string;
};
type StepRequestMap = Partial<Record<StepName, StepRequestLog[]>>;

const highlightJson = (value: unknown) => {
  if (value === undefined) return '';
  const jsonString = JSON.stringify(value, null, 2);
  if (!jsonString) return '';

  const escaped = jsonString
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    match => {
      let color = '#bae6fd';
      if (match.startsWith('"')) {
        color = match.endsWith(':') ? '#38bdf8' : '#34d399';
      } else if (match === 'true' || match === 'false') {
        color = '#facc15';
      } else if (match === 'null') {
        color = '#94a3b8';
      } else {
        color = '#f97316';
      }
      return `<span style="color: ${color}">${match}</span>`;
    }
  );
};

const buildInitialStepStatuses = (steps: StepName[]): Record<StepName, StepStatus> => {
  const initial = {} as Record<StepName, StepStatus>;
  for (const step of steps) initial[step] = 'pending';
  return initial;
};

const STATUS_UI: Record<StepStatus, { icon: string; color: string; label: string }> = {
  pending: { icon: '•', color: '#94a3b8', label: 'Pending' },
  'in-progress': { icon: '…', color: '#f59e0b', label: 'In progress' },
  success: { icon: '✓', color: '#22c55e', label: 'Success' },
  failure: { icon: '✕', color: '#ef4444', label: 'Failure' }
};

const stringifyValue = (value: unknown): string => {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const stringifyValueForCopy = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

function CopyButton({ value, label }: { value?: string | null; label: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canCopy = typeof value === 'string' && value.trim().length > 0;

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        disabled={!canCopy}
        onClick={() => {
          if (!canCopy) return;
          const textToCopy = value ?? '';
          const markCopied = () => {
            setIsCopied(true);
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => {
              setIsCopied(false);
              timeoutRef.current = null;
            }, 1500);
          };

          const clipboard = navigator.clipboard;
          if (clipboard?.writeText) {
            clipboard.writeText(textToCopy).then(markCopied).catch(() => {
              /* ignore clipboard errors */
            });
            return;
          }

          try {
            const textarea = document.createElement('textarea');
            textarea.value = textToCopy;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (copied) markCopied();
          } catch {
            /* ignore clipboard errors */
          }
        }}
        title={label}
        aria-label={label}
        style={{
          border: '1px solid #1f2937',
          background: '#1e293b',
          color: '#f8fafc',
          padding: '4px 6px',
          borderRadius: 6,
          cursor: canCopy ? 'pointer' : 'not-allowed',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: canCopy ? 1 : 0.6
        }}
      >
        <svg
          aria-hidden="true"
          focusable="false"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block' }}
        >
          <path
            d="M8 3H17L21 7V21H8V3Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M3 3H8V21H3V3Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {isCopied ? (
        <span
          role="status"
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            transform: 'translateY(-6px)',
            background: '#0b1220',
            color: '#e2e8f0',
            border: '1px solid #1e293b',
            borderRadius: 6,
            padding: '4px 6px',
            fontSize: 11,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(15, 23, 42, 0.45)'
          }}
        >
          Copied
        </span>
      ) : null}
    </div>
  );
}

export default function Runner({ flow, mode, toStep }: { flow: FlowVariant; mode: 'full'|'toStep'; toStep?: string }) {
  const definition = FLOW_DEFINITIONS[flow];
  const stepIds = useMemo<StepName[]>(() => definition.steps.map(step => step.id), [definition]);
  const stepLabelLookup = useMemo(() => {
    const map = new Map<StepName, { label: string; index: number }>();
    definition.steps.forEach((step, index) => {
      map.set(step.id, { label: step.label, index });
    });
    return map;
  }, [definition]);

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [challengeSnapshots, setChallengeSnapshots] = useState<ChallengeSnapshot[]>([]);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [lastRefreshTimestamp, setLastRefreshTimestamp] = useState<string | null>(null);
  const [runToken, setRunToken] = useState(0);
  const [stepStatuses, setStepStatuses] = useState<Record<StepName, StepStatus>>(() => buildInitialStepStatuses(stepIds));
  const [stepFailures, setStepFailures] = useState<StepRequestMap>({});
  const [stepRequests, setStepRequests] = useState<StepRequestMap>({});
  const [openStep, setOpenStep] = useState<StepName | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<{ step: StepName; item: StepRequestLog } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const snapshotCounterRef = useRef(0);
  const copyTooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isCopyTooltipVisible, setIsCopyTooltipVisible] = useState(false);

  useEffect(() => {
    setStepStatuses(buildInitialStepStatuses(stepIds));
    setStepFailures({});
    setStepRequests({});
    setOpenStep(null);
    setSelectedRequest(null);
  }, [stepIds]);

  useEffect(() => {
    if (runToken === 0) return;
    const params = new URLSearchParams({ mode, flow });
    if (toStep) params.set('toStep', toStep);
    const es = new EventSource(`/api/run/stream?${params.toString()}`);
    sourceRef.current = es;
    setIsRunning(true);

    const handleStepEvent = (event: StepEvent) => {
      setStepStatuses(prev => ({ ...prev, [event.step]: event.status }));
      if (event.requests !== undefined) {
        setStepRequests(prev => ({ ...prev, [event.step]: event.requests ?? [] }));
        setSelectedRequest(prev => {
          if (!prev || prev.step !== event.step) return prev;
          const updated = (event.requests ?? []).find(r => r.id === prev.item.id);
          if (!updated) return null;
          return { step: event.step, item: updated };
        });
      }
      if (event.failedRequests !== undefined) {
        setStepFailures(prev => ({ ...prev, [event.step]: event.failedRequests ?? [] }));
      } else if (event.status !== 'failure') {
        setStepFailures(prev => {
          if (!(event.step in prev)) return prev;
          const next = { ...prev } as StepRequestMap;
          delete next[event.step];
          return next;
        });
      }
    };

    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed?.type === 'step') {
          handleStepEvent(parsed as StepEvent);
          return;
        }
        const data: LogEntry = parsed;
        if (typeof data.progress === 'number') setProgress(data.progress);

        let shouldLog = true;
        if (data.message === 'Challenge refresh' && data.data?.challenge) {
          snapshotCounterRef.current += 1;
          setRefreshCount(snapshotCounterRef.current);
          const stage = typeof data.data.stage === 'string' ? data.data.stage : undefined;
          const currentChallenge = data.data.challenge;
          const extractedId = (() => {
            if (!currentChallenge) return null;
            const idCandidate = currentChallenge.id ?? currentChallenge.challengeId ?? currentChallenge.challenge?.id;
            if (typeof idCandidate === 'string' || typeof idCandidate === 'number') return String(idCandidate);
            return null;
          })();
          if (extractedId) setChallengeId(extractedId);
          if (copyTooltipTimeoutRef.current) {
            clearTimeout(copyTooltipTimeoutRef.current);
            copyTooltipTimeoutRef.current = null;
          }
          setIsCopyTooltipVisible(false);
          const timestamp = new Date().toISOString();
          setLastRefreshTimestamp(timestamp);
          setChallengeSnapshots([{
            id: snapshotCounterRef.current,
            stage,
            timestamp,
            challenge: currentChallenge
          }]);
          shouldLog = false;
        }

        const normalized = data.message?.toLowerCase?.() || '';
        if (normalized.includes('run finished') || normalized.includes('run cancelled') || data.level === 'error' || data.progress === 100) {
          setIsRunning(false);
        }

        if (shouldLog) setLogs(prev => [...prev, data]);
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
      } catch {
        // ignore malformed log entries
      }
    };

    es.onerror = () => {
      es.close();
      if (sourceRef.current === es) sourceRef.current = null;
      setIsRunning(false);
    };

    return () => {
      es.close();
      if (sourceRef.current === es) sourceRef.current = null;
    };
  }, [runToken, mode, toStep, flow]);

  useEffect(() => {
    return () => {
      if (copyTooltipTimeoutRef.current) {
        clearTimeout(copyTooltipTimeoutRef.current);
        copyTooltipTimeoutRef.current = null;
      }
    };
  }, []);

  const startRun = () => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setIsRunning(false);
    setLogs([]);
    setChallengeSnapshots([]);
    setChallengeId(null);
    setRefreshCount(0);
    setLastRefreshTimestamp(null);
    snapshotCounterRef.current = 0;
    setProgress(0);
    setStepStatuses(buildInitialStepStatuses(stepIds));
    setStepFailures({});
    setStepRequests({});
    setOpenStep(null);
    setSelectedRequest(null);
    setRunToken(prev => prev + 1);
  };

  const requestEntries = openStep ? stepRequests[openStep] ?? [] : [];
  const selectedRequestItem = selectedRequest?.item;
  const selectedEndpointDisplay = selectedRequestItem?.endpoint || 'Unknown';
  const selectedEndpointCopyValue = selectedRequestItem?.endpoint ?? '';
  const selectedRequestBodyDisplay = stringifyValue(selectedRequestItem?.requestBody);
  const selectedRequestBodyCopyValue = stringifyValueForCopy(selectedRequestItem?.requestBody);
  const selectedResponseBodyDisplay = stringifyValue(selectedRequestItem?.responseBody);
  const selectedResponseBodyCopyValue = stringifyValueForCopy(selectedRequestItem?.responseBody);
  const selectedResponseHeadersDisplay = selectedRequestItem?.responseHeaders
    ? stringifyValue(selectedRequestItem.responseHeaders)
    : '';
  const selectedResponseHeadersCopyValue = stringifyValueForCopy(selectedRequestItem?.responseHeaders);

  const formatStepTitle = (step: StepName): string => {
    const entry = stepLabelLookup.get(step);
    if (!entry) return step;
    const prefix = `${String(entry.index + 1).padStart(2, '0')}. `;
    return `${prefix}${entry.label}`;
  };

  return (
    <>
      <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap' }}>
      <div className="col" style={{ minWidth: 0 }}>
        <div className="card" style={{ height: '100%' }}>
          <h3>Run</h3>
          <div className="progress" style={{marginBottom: 8}}><div className="bar" style={{ width: progress+'%' }} /></div>
          <div style={{display:'flex', gap:8, marginBottom: 8}}>
            <button onClick={startRun}>{isRunning ? 'Restart' : 'Start'}</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '0 0 8px' }}>Step status</h4>
            <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              {definition.steps.map(stepInfo => {
                const step = stepInfo.id;
                const status = stepStatuses[step] ?? 'pending';
                const ui = STATUS_UI[status];
                const requestsForStep = stepRequests[step] ?? [];
                const allowOpen = status !== 'pending' || requestsForStep.length > 0;
                const failureCount = (stepFailures[step] ?? []).length;
                return (
                  <button
                    key={step}
                    type="button"
                    disabled={!allowOpen}
                    onClick={() => {
                      if (!allowOpen) return;
                      setOpenStep(step);
                      setSelectedRequest(null);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: '1px solid #1f2937',
                      background: '#0f172a',
                      color: '#e2e8f0',
                      cursor: allowOpen ? 'pointer' : 'default',
                      opacity: allowOpen ? 1 : 0.8,
                      textAlign: 'left'
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: ui.color, fontWeight: 700, fontSize: 18, lineHeight: 1 }}>{ui.icon}</span>
                      <span style={{ fontWeight: 500 }}>{formatStepTitle(step)}</span>
                    </span>
                    <span style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 8 }}>
                      {ui.label}
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: '#1e293b',
                        color: '#cbd5f5',
                        fontSize: 11,
                        fontWeight: 600
                      }}>
                        {requestsForStep.length} call{requestsForStep.length === 1 ? '' : 's'}
                      </span>
                      {failureCount > 0 ? (
                        <span style={{
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: '#7f1d1d',
                          color: '#fee2e2',
                          fontSize: 11,
                          fontWeight: 600
                        }}>
                          {failureCount} error{failureCount === 1 ? '' : 's'}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div ref={logRef} className="log">
            {logs.map((l,i)=>(
              <div key={i}>
                <span>[{l.level.toUpperCase()}]</span> {l.message} {l.data ? <pre style={{display:'inline', marginLeft:6}}>{JSON.stringify(l.data)}</pre> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="col" style={{ minWidth: 0 }}>
        <div className="card" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ marginBottom: 0 }}>Challenge snapshots</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-end', textAlign: 'right', flexWrap: 'wrap' }}>
              <span style={{ color: '#94a3b8', fontSize: 12 }}>
                {lastRefreshTimestamp
                  ? `Last refresh ${new Date(lastRefreshTimestamp).toLocaleString()} • ${refreshCount} refresh${refreshCount === 1 ? '' : 'es'}`
                  : 'No refreshes yet'}
              </span>
              {challengeId ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', textAlign: 'right' }}>
                  <span style={{ color: '#94a3b8', fontWeight: 500 }}>ID {challengeId}</span>
                  <div style={{ position: 'relative', display: 'inline-flex' }}>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(challengeId);
                        setIsCopyTooltipVisible(true);
                        if (copyTooltipTimeoutRef.current) clearTimeout(copyTooltipTimeoutRef.current);
                        copyTooltipTimeoutRef.current = setTimeout(() => {
                          setIsCopyTooltipVisible(false);
                          copyTooltipTimeoutRef.current = null;
                        }, 2000);
                      }}
                      title="Copy challenge ID"
                      aria-label="Copy challenge ID"
                      style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 6px' }}
                    >
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        style={{ display: 'block' }}
                      >
                        <path
                          d="M8 3H17L21 7V21H8V3Z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M3 3H8V21H3V3Z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    {isCopyTooltipVisible ? (
                      <div
                        role="status"
                        style={{
                          position: 'absolute',
                          bottom: '100%',
                          right: 0,
                          transform: 'translateY(-6px)',
                          background: '#0b1220',
                          color: '#e2e8f0',
                          border: '1px solid #1e293b',
                          borderRadius: 6,
                          padding: '6px 8px',
                          fontSize: 11,
                          whiteSpace: 'nowrap',
                          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.45)'
                        }}
                      >
                        Challenge ID copied to clipboard
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div style={{
            background: '#0b1220',
            border: '1px solid #1e293b',
            borderRadius: 8,
            padding: 12,
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12,
            flex: 1,
            minHeight: 0
          }}>
            {challengeSnapshots.length === 0 ? (
              <div style={{ color: '#94a3b8' }}>Waiting for challenge refreshes…</div>
            ) : (
              challengeSnapshots.map(snapshot => (
                <div key={snapshot.id} style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8' }}>
                    <span>Refresh #{snapshot.id}{snapshot.stage ? ` • ${snapshot.stage}` : ''}</span>
                    <span>{new Date(snapshot.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre
                    style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}
                    dangerouslySetInnerHTML={{ __html: highlightJson(snapshot.challenge) }}
                  />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
      {openStep ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 20
          }}
        >
          <div
            style={{
              width: 'min(600px, 100%)',
              maxHeight: '80vh',
              overflowY: 'auto',
              background: '#0f172a',
              border: '1px solid #1f2937',
              borderRadius: 12,
              padding: 20,
              color: '#e2e8f0',
              boxShadow: '0 20px 45px rgba(15, 23, 42, 0.6)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>Step requests</h3>
                <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 14 }}>{formatStepTitle(openStep)}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpenStep(null);
                  setSelectedRequest(null);
                }}
                style={{
                  border: '1px solid #1f2937',
                  background: '#1e293b',
                  color: '#f8fafc',
                  padding: '4px 8px',
                  borderRadius: 6,
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
            {requestEntries.length === 0 ? (
              <p style={{ marginTop: 16, color: '#94a3b8' }}>No requests were captured for this step yet.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {requestEntries.map((request) => {
                  const summaryParts = [request.method, request.endpoint].filter(Boolean).join(' ');
                  const statusLabel = request.status !== undefined ? String(request.status) : '—';
                  const statusColor = request.outcome === 'failure' ? '#f87171' : '#34d399';
                  const timestampLabel = request.timestamp ? new Date(request.timestamp).toLocaleTimeString() : null;
                  return (
                    <li
                      key={request.id}
                      style={{
                        border: '1px solid #1f2937',
                        borderRadius: 8,
                        padding: 12,
                        background: '#111c30',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: 12
                      }}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={{ fontWeight: 600 }}>{summaryParts || request.message || 'Request'}</span>
                        <span style={{ fontSize: 12, color: '#94a3b8', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              minWidth: 30,
                              padding: '2px 6px',
                              borderRadius: 6,
                              background: '#1f2937',
                              color: statusColor,
                              fontWeight: 600
                            }}>
                              {statusLabel}
                            </span>
                            <span style={{ color: statusColor, fontWeight: 600 }}>{request.outcome === 'failure' ? 'Failure' : 'Success'}</span>
                          </span>
                          {timestampLabel ? <span>{timestampLabel}</span> : null}
                          {typeof request.durationMs === 'number' ? <span>{request.durationMs}ms</span> : null}
                          {request.message ? <span>{request.message}</span> : null}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedRequest({ step: openStep, item: request })}
                        style={{
                          border: '1px solid #1f2937',
                          background: '#1e293b',
                          color: '#f8fafc',
                          padding: '4px 10px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        View details
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : null}
      {selectedRequest ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            zIndex: 30
          }}
        >
          <div
            style={{
              width: 'min(640px, 100%)',
              maxHeight: '85vh',
              overflowY: 'auto',
              background: '#0f172a',
              border: '1px solid #1f2937',
              borderRadius: 12,
              padding: 24,
              color: '#e2e8f0',
              boxShadow: '0 24px 60px rgba(15, 23, 42, 0.65)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <h3 style={{ margin: 0 }}>Request details</h3>
                <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 14 }}>{formatStepTitle(selectedRequest.step)}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedRequest(null)}
                style={{
                  border: '1px solid #1f2937',
                  background: '#1e293b',
                  color: '#f8fafc',
                  padding: '4px 8px',
                  borderRadius: 6,
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Endpoint</span>
                  <CopyButton value={selectedEndpointCopyValue} label="Copy endpoint" />
                </div>
                <div style={{ fontWeight: 600 }}>{selectedEndpointDisplay}</div>
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Method</span>
                  <div style={{ fontWeight: 600 }}>{selectedRequest.item.method || 'Unknown'}</div>
                </div>
                <div>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Status code</span>
                  <div style={{ fontWeight: 600 }}>{selectedRequest.item.status ?? 'Unknown'}</div>
                </div>
              </div>
              <div>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>Outcome</span>
                <div style={{ fontWeight: 600, color: selectedRequest.item.outcome === 'failure' ? '#f87171' : '#34d399' }}>
                  {selectedRequest.item.outcome === 'failure' ? 'Failure' : 'Success'}
                </div>
              </div>
              {selectedRequest.item.message ? (
                <div>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Message</span>
                  <div>{selectedRequest.item.message}</div>
                </div>
              ) : null}
              {typeof selectedRequest.item.durationMs === 'number' ? (
                <div>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Duration</span>
                  <div>{selectedRequest.item.durationMs}ms</div>
                </div>
              ) : null}
              {selectedRequest.item.timestamp ? (
                <div>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Timestamp</span>
                  <div>{new Date(selectedRequest.item.timestamp).toLocaleString()}</div>
                </div>
              ) : null}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Request body</span>
                  <CopyButton value={selectedRequestBodyCopyValue} label="Copy request body" />
                </div>
                <pre
                  style={{
                    background: '#111c30',
                    border: '1px solid #1f2937',
                    borderRadius: 8,
                    padding: 12,
                    overflowX: 'auto'
                  }}
                >
                  {selectedRequestBodyDisplay}
                </pre>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#94a3b8' }}>Response body</span>
                  <CopyButton value={selectedResponseBodyCopyValue} label="Copy response body" />
                </div>
                <pre
                  style={{
                    background: '#111c30',
                    border: '1px solid #1f2937',
                    borderRadius: 8,
                    padding: 12,
                    overflowX: 'auto'
                  }}
                >
                  {selectedResponseBodyDisplay}
                </pre>
              </div>
              {selectedRequest.item.responseHeaders ? (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>Response headers</span>
                    <CopyButton value={selectedResponseHeadersCopyValue} label="Copy response headers" />
                  </div>
                  <pre
                    style={{
                      background: '#111c30',
                      border: '1px solid #1f2937',
                      borderRadius: 8,
                      padding: 12,
                      overflowX: 'auto'
                    }}
                  >
                    {selectedResponseHeadersDisplay}
                  </pre>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
