
import dayjs from 'dayjs';
import { nanoid } from 'nanoid';
import { RunnerLogger, type StepRequestLog, type StepStatus } from '../utils/logger.js';
import { setActiveStepRequestRecorder, type StepRequestLogInput } from '../utils/stepRequestRecorder.js';
import { getToken, TC } from './topcoder.js';
import { loadSubmissionArtifact, uploadSubmissionArtifact } from './submissionUploader.js';
import type { FlowConfig } from '../types/config.js';

type CancellationHelpers = {
  check: () => void;
  wait: (ms: number) => Promise<void>;
};

function createCancellationHelpers(signal: AbortSignal | undefined, log: RunnerLogger): CancellationHelpers {
  let notified = false;
  const cancellationError = () => {
    const err = new Error('__CANCELLED__');
    err.name = 'RunCancelled';
    return err;
  };

  const check = () => {
    if (signal?.aborted) {
      if (!notified) {
        log.info('Cancellation requested');
        notified = true;
      }
      throw cancellationError();
    }
  };

  const wait = (ms: number) => {
    if (!signal) {
      return new Promise<void>(resolve => setTimeout(resolve, ms));
    }
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        try {
          check();
        } catch (err) {
          reject(err);
          return;
        }
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = () => {
        cleanup();
        reject(cancellationError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
    });
  };

  return { check, wait };
}

export type RunMode = 'full' | 'toStep';
export type StepName =
  | 'token' | 'createChallenge' | 'updateDraft' | 'activate'
  | 'awaitRegSubOpen' | 'assignResources' | 'createSubmissions'
  | 'awaitReviewOpen' | 'createReviews' | 'awaitAppealsOpen'
  | 'createAppeals' | 'awaitAppealsResponseOpen' | 'appealResponses'
  | 'awaitAllClosed' | 'awaitCompletion';


function maybeStop(mode: RunMode, toStep: StepName|undefined, current: StepName, log: RunnerLogger) {
  if (mode === 'toStep' && toStep === current) {
    log.info(`Stopping at step '${current}' as requested`, { step: current }, 100);
    throw new Error('__STOP_EARLY__');
  }
}

const DEFAULT_REVIEW_PHASE_ID = 'aa5a3f78-79e0-4bf7-93ff-b11e8f5b398b';
const DEFAULT_REVIEWER_BASE_PAYMENT = 50;
const DEFAULT_REVIEWER_INCREMENTAL_PAYMENT = 20;

const STEPS: StepName[] = [
  'token','createChallenge','updateDraft','activate',
  'awaitRegSubOpen','assignResources','createSubmissions',
  'awaitReviewOpen','createReviews','awaitAppealsOpen',
  'createAppeals','awaitAppealsResponseOpen','appealResponses',
  'awaitAllClosed','awaitCompletion'
];

const PROGRESS_STEPS: StepName[] = STEPS.filter(step => step !== 'token');

function getStepProgress(step: StepName): number | undefined {
  const idx = PROGRESS_STEPS.indexOf(step);
  if (idx === -1) return undefined;
  const value = ((idx + 1) / PROGRESS_STEPS.length) * 100;
  return Number(value.toFixed(2));
}

function logChallengeSnapshot(log: RunnerLogger, stage: string, challenge: any) {
  log.info('Challenge refresh', { stage, challenge });
}

type StepContext = {
  recordRequest: (detail: StepRequestLogInput) => StepRequestLog;
  recordFailure: (error: any, overrides?: Partial<StepRequestLog>) => StepRequestLog;
  recordFailureDetail: (detail: StepRequestLog) => StepRequestLog;
  getFailures: () => StepRequestLog[];
  getRequests: () => StepRequestLog[];
};

function initializeStepStatuses(log: RunnerLogger) {
  for (const step of STEPS) {
    log.step({ step, status: 'pending' });
  }
}

function normalizeRequestBody(data: unknown) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function extractStepFailure(error: any): StepRequestLog {
  const response = error?.response;
  const config = response?.config ?? error?.config ?? {};
  const method = typeof config.method === 'string' ? config.method.toUpperCase() : undefined;
  const endpoint = typeof config.url === 'string' ? config.url : undefined;
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const requestBody = normalizeRequestBody(config.data);
  const startedAt = typeof (config as any).__requestStart === 'number' ? (config as any).__requestStart : undefined;
  const durationMs = startedAt ? Date.now() - startedAt : undefined;
  const failure: StepRequestLog = {
    id: nanoid(10),
    method,
    endpoint,
    status,
    message: typeof error?.message === 'string' ? error.message : undefined,
    requestBody,
    responseBody: response?.data,
    responseHeaders: response?.headers,
    durationMs,
    timestamp: new Date().toISOString(),
    outcome: 'failure'
  };
  return failure;
}

function toStringId(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

async function resolvePhaseIdByName(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  phaseName: string,
  cancel: CancellationHelpers
): Promise<string | undefined> {
  const normalized = phaseName.trim().toLowerCase();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    cancel.check();
    try {
      const challenge = await TC.getChallenge(token, challengeId);
      const phases = Array.isArray(challenge?.phases) ? challenge.phases : [];
      for (const phase of phases) {
        if (!phase) continue;
        const name = typeof phase.name === 'string' ? phase.name.toLowerCase() : '';
        if (name !== normalized) continue;
        // Prefer the phase TEMPLATE id (phaseId) over the runtime phase id (id)
        const candidate =
          toStringId((phase as any).phaseId) ||
          toStringId((phase as any).phase_id) ||
          toStringId((phase as any).id) ||
          toStringId((phase as any).legacyId);
        if (candidate) {
          return candidate;
        }
      }
    } catch (error: any) {
      log.warn('Failed to load challenge while locating phase ID', {
        challengeId,
        phase: phaseName,
        attempt: attempt + 1,
        error: error?.message || String(error)
      });
    }
    if (attempt < 2) {
      await cancel.wait(500);
    }
  }
  return undefined;
}

async function withStep<T>(
  log: RunnerLogger,
  step: StepName,
  runner: (ctx: StepContext) => Promise<T>
): Promise<T> {
  const requests: StepRequestLog[] = [];
  const failures: StepRequestLog[] = [];
  let currentStatus: StepStatus = 'pending';

  const cloneEntries = (entries: StepRequestLog[]) => entries.map(entry => ({ ...entry }));

  const dispatch = (status?: StepStatus) => {
    if (status) currentStatus = status;
    log.step({
      step,
      status: currentStatus,
      requests: requests.length ? cloneEntries(requests) : undefined,
      failedRequests: failures.length ? cloneEntries(failures) : undefined
    });
  };

  const upsertFailureList = (entry: StepRequestLog) => {
    const idx = failures.findIndex(f => f.id === entry.id);
    if (entry.outcome === 'failure') {
      if (idx === -1) failures.push(entry);
    } else if (idx !== -1) {
      failures.splice(idx, 1);
    }
  };

  const applyDetailToEntry = (entry: StepRequestLog, detail: StepRequestLogInput) => {
    if (detail.method !== undefined) entry.method = detail.method;
    if (detail.endpoint !== undefined) entry.endpoint = detail.endpoint;
    if (detail.status !== undefined) entry.status = detail.status;
    if (detail.message !== undefined) entry.message = detail.message;
    if (detail.requestBody !== undefined) entry.requestBody = detail.requestBody;
    if (detail.responseBody !== undefined) entry.responseBody = detail.responseBody;
    if (detail.responseHeaders !== undefined) entry.responseHeaders = detail.responseHeaders;
    if (detail.durationMs !== undefined) entry.durationMs = detail.durationMs;
    if (detail.timestamp !== undefined) entry.timestamp = detail.timestamp;
    if (detail.outcome !== undefined) entry.outcome = detail.outcome;
  };

  const recordRequestInternal = (detail: StepRequestLogInput): StepRequestLog => {
    const id = detail.id ?? nanoid(10);
    let entry = requests.find(r => r.id === id);
    if (!entry) {
      entry = {
        id,
        outcome: detail.outcome ?? 'success',
        timestamp: detail.timestamp ?? new Date().toISOString()
      };
      requests.push(entry);
    }
    if (!entry.timestamp) entry.timestamp = detail.timestamp ?? new Date().toISOString();
    applyDetailToEntry(entry, { ...detail, id });
    if (!entry.outcome) entry.outcome = 'success';
    upsertFailureList(entry);
    dispatch();
    return entry;
  };

  const stepCtx: StepContext = {
    recordRequest: (detail: StepRequestLogInput) => recordRequestInternal(detail),
    recordFailure: (error: any, overrides?: Partial<StepRequestLog>) => {
      const base = extractStepFailure(error);
      const errorRequestId = typeof (error as any)?.__stepRequestId === 'string' ? (error as any).__stepRequestId : undefined;
      const detail: StepRequestLogInput = {
        ...base,
        ...(overrides ?? {}),
        id: overrides?.id ?? errorRequestId ?? base.id,
        outcome: 'failure'
      };
      const entry = recordRequestInternal(detail);
      dispatch('failure');
      return entry;
    },
    recordFailureDetail: (detail: StepRequestLog) => {
      const entry = recordRequestInternal({ ...detail, outcome: 'failure' });
      dispatch('failure');
      return entry;
    },
    getFailures: () => cloneEntries(failures),
    getRequests: () => cloneEntries(requests)
  };

  dispatch('in-progress');
  setActiveStepRequestRecorder((detail) => recordRequestInternal(detail));
  try {
    const result = await runner(stepCtx);
    dispatch(failures.length === 0 ? 'success' : 'failure');
    return result;
  } catch (error) {
    stepCtx.recordFailure(error);
    throw error;
  } finally {
    setActiveStepRequestRecorder(null);
  }
}


export async function runFlow(
  cfg: FlowConfig,
  mode: RunMode,
  toStep: StepName | undefined,
  log: RunnerLogger,
  signal?: AbortSignal
) {
  const { writeLastRun, resetLastRun } = await import('../utils/lastRun.js');
  const cancel = createCancellationHelpers(signal, log);

  resetLastRun();
  initializeStepStatuses(log);

  cancel.check();
  maybeStop(mode, toStep, 'token', log);
  const token = await withStep(log, 'token', (ctx) => stepToken(log, cancel, ctx));
  cancel.check();
  maybeStop(mode, toStep, 'token', log);
  const challenge = await withStep(log, 'createChallenge', (ctx) => stepCreateChallenge(log, token, cfg, cancel, ctx));
  writeLastRun({ challengeId: challenge.id, challengeName: challenge.name });
  cancel.check();
  maybeStop(mode, toStep, 'createChallenge', log);
  await withStep(log, 'updateDraft', (ctx) => stepUpdateDraft(log, token, cfg, challenge.id, cancel, ctx));
  maybeStop(mode, toStep, 'updateDraft', log);
  cancel.check();
  await withStep(log, 'activate', (ctx) => stepActivate(log, token, challenge.id, cancel, ctx));
  maybeStop(mode, toStep, 'activate', log);

  await withStep(log, 'awaitRegSubOpen', (ctx) => stepAwaitPhasesOpen(log, token, challenge.id, ['Registration','Submission'], 'awaitRegSubOpen', [], cancel, ctx));
  maybeStop(mode, toStep, 'awaitRegSubOpen', log);
  cancel.check();
  await withStep(log, 'assignResources', (ctx) => stepAssignResources(log, token, cfg, challenge.id, cancel, ctx));
  maybeStop(mode, toStep, 'assignResources', log);
  cancel.check();
  await withStep(log, 'createSubmissions', (ctx) => stepCreateSubmissions(log, token, cfg, challenge.id, cancel, ctx));
  maybeStop(mode, toStep, 'createSubmissions', log);

  await withStep(log, 'awaitReviewOpen', (ctx) => stepAwaitPhasesOpen(log, token, challenge.id, ['Review'], 'awaitReviewOpen', ['Registration','Submission'], cancel, ctx));
  maybeStop(mode, toStep, 'awaitReviewOpen', log);
  cancel.check();
  const reviewInfo = await withStep(log, 'createReviews', (ctx) => stepCreateReviews(log, token, cfg, challenge.id, cancel, ctx));
  maybeStop(mode, toStep, 'createReviews', log);

  await withStep(log, 'awaitAppealsOpen', (ctx) => stepAwaitPhasesOpen(log, token, challenge.id, ['Appeals'], 'awaitAppealsOpen', ['Review'], cancel, ctx));
  maybeStop(mode, toStep, 'awaitAppealsOpen', log);
  cancel.check();
  const appeals = await withStep(log, 'createAppeals', (ctx) => stepCreateAppeals(log, token, cfg, reviewInfo, cancel, ctx));
  maybeStop(mode, toStep, 'createAppeals', log);

  await withStep(log, 'awaitAppealsResponseOpen', (ctx) => stepAwaitPhasesOpen(log, token, challenge.id, ['Appeals Response'], 'awaitAppealsResponseOpen', ['Appeals'], cancel, ctx));
  maybeStop(mode, toStep, 'awaitAppealsResponseOpen', log);
  cancel.check();
  await withStep(log, 'appealResponses', (ctx) => stepAppealResponses(log, token, cfg, appeals, cancel, ctx));
  maybeStop(mode, toStep, 'appealResponses', log);

  await withStep(log, 'awaitAllClosed', (ctx) => stepAwaitAllClosed(log, token, challenge.id, cancel, ctx));
  maybeStop(mode, toStep, 'awaitAllClosed', log);
  await withStep(log, 'awaitCompletion', (ctx) => stepAwaitCompletion(log, token, challenge.id, cancel, ctx));

  log.info('Flow complete', { challengeId: challenge.id }, 100);
}

async function stepToken(log: RunnerLogger, cancel: CancellationHelpers, ctx?: StepContext) {
  cancel.check();
  log.info('Generating M2M token...');
  const token = await getToken();
  cancel.check();
  log.info('Token acquired');
  return token;
}

async function stepCreateChallenge(
  log: RunnerLogger,
  token: string,
  cfg: FlowConfig,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  cancel.check();
  log.info('Creating challenge...');
  const challengeName = `${cfg.challengeNamePrefix}${nanoid(8)}`;
  const payload = {
    name: challengeName,
    typeId: cfg.challengeTypeId,
    trackId: cfg.challengeTrackId,
    timelineTemplateId: cfg.timelineTemplateId,
    projectId: cfg.projectId,
    status: 'NEW',
    description: 'End-to-end test',
    discussions: [
      {
        name: `${challengeName} Discussion`,
        type: 'CHALLENGE',
        provider: 'vanilla'
      }
    ]
  };
  const ch = await TC.createChallenge(token, payload);
  cancel.check();
  log.info('Challenge created', { id: ch.id, name: challengeName, request: payload, responseId: ch.id }, getStepProgress('createChallenge'));
  return ch;
}

async function stepUpdateDraft(
  log: RunnerLogger,
  token: string,
  cfg: FlowConfig,
  challengeId: string,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  cancel.check();
  log.info('Updating challenge to DRAFT with 1-minute timeline...');
  const reviewerCount = Math.max(Array.isArray(cfg.reviewers) ? cfg.reviewers.length : 0, 1);
  const reviewPhaseId = (await resolvePhaseIdByName(log, token, challengeId, 'Review', cancel))
    ?? DEFAULT_REVIEW_PHASE_ID;
  const nowIso = dayjs().toISOString();
  const body = {
    typeId: cfg.challengeTypeId,
    trackId: cfg.challengeTrackId,
    name: `${cfg.challengeNamePrefix}${nanoid(6)}`,
    description: 'Challenge API Tester',
    tags: [], groups: [], metadata: [],
    startDate: nowIso,
    prizeSets: [
      { type: 'PLACEMENT', prizes: [
        { type: 'USD', value: cfg.prizes[0] },
        { type: 'USD', value: cfg.prizes[1] },
        { type: 'USD', value: cfg.prizes[2] }
      ]},
      { type: 'COPILOT', prizes: [{ type: 'USD', value: 100 }]}
    ],
    winners: [], discussions: [],
    reviewers: [
      {
        scorecardId: cfg.scorecardId,
        isMemberReview: true,
        memberReviewerCount: reviewerCount,
        phaseId: reviewPhaseId,
        basePayment: DEFAULT_REVIEWER_BASE_PAYMENT,
        incrementalPayment: DEFAULT_REVIEWER_INCREMENTAL_PAYMENT,
        type: 'REGULAR_REVIEW'
      }
    ],
    task: { isTask: false, isAssigned: false },
    skills: [{ name: 'Java', id: '63bb7cfc-b0d4-4584-820a-18c503b4b0fe' }],
    legacy: {
      reviewType: 'COMMUNITY',
      confidentialityType: 'public',
      directProjectId: 33540,
      isTask: false, useSchedulingAPI: false, pureV5Task: false, pureV5: false, selfService: false
    },
    timelineTemplateId: cfg.timelineTemplateId,
    projectId: cfg.projectId,
    status: 'DRAFT',
    attachmentIds: []
  };
  // Sanity check: ensure reviewer phaseIds correspond to phase TEMPLATE ids on the challenge
  await sanityCheckReviewerPhaseTemplates(log, token, challengeId, body.reviewers as Array<{ phaseId?: string }>, cancel);
  const updated = await TC.updateChallenge(token, challengeId, body);
  cancel.check();
  log.info('Challenge updated to DRAFT', { challengeId, request: body }, getStepProgress('updateDraft'));
  log.info('Configured review settings', {
    challengeId,
    reviewPhaseId,
    reviewerCount,
    scorecardId: cfg.scorecardId
  });
  return updated;
}

async function sanityCheckReviewerPhaseTemplates(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  reviewers: Array<{ phaseId?: string }>,
  cancel: CancellationHelpers,
) {
  try {
    cancel.check();
    const challenge = await TC.getChallenge(token, challengeId);
    const phases: any[] = Array.isArray(challenge?.phases) ? challenge.phases : [];
    const templateIds = new Set(
      phases
        .map((p: any) => (typeof p?.phaseId === 'string' ? p.phaseId : (typeof p?.phase_id === 'string' ? p.phase_id : undefined)))
        .filter(Boolean)
    );
    const runtimeIds = new Set(
      phases
        .map((p: any) => (typeof p?.id === 'string' ? p.id : undefined))
        .filter(Boolean)
    );

    const unknown: string[] = [];
    const looksRuntime: string[] = [];
    for (const r of reviewers) {
      const pid = typeof r?.phaseId === 'string' ? r.phaseId : undefined;
      if (!pid) continue;
      if (!templateIds.has(pid)) {
        unknown.push(pid);
        if (runtimeIds.has(pid)) {
          looksRuntime.push(pid);
        }
      }
    }

    if (unknown.length) {
      log.warn('Reviewer phaseId sanity check: some IDs are not template IDs', {
        challengeId,
        unknownPhaseIds: Array.from(new Set(unknown)),
        lookLikeRuntimeIds: Array.from(new Set(looksRuntime)),
        knownTemplateIdsCount: templateIds.size,
      });
    } else {
      log.info('Reviewer phaseId sanity check passed', {
        challengeId,
        reviewers: reviewers.length,
        templateIds: templateIds.size,
      });
    }
  } catch (error: any) {
    log.warn('Reviewer phaseId sanity check failed (non-fatal)', {
      challengeId,
      error: error?.message || String(error),
    });
  }
}

async function stepActivate(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  cancel.check();
  log.info('Activating challenge...');
  const active = await TC.activateChallenge(token, challengeId);
  cancel.check();
  log.info('Challenge set ACTIVE', { challengeId, request: { status: 'ACTIVE' } }, getStepProgress('activate'));
  return active;
}

async function stepAwaitPhasesOpen(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  mustOpen: string[],
  progressStep: StepName,
  mustClose: string[] = [],
  cancel?: CancellationHelpers,
  ctx?: StepContext
) {
  log.info(`Waiting for phases to open/close: open=${mustOpen.join(', ')} close=${mustClose.join(', ')}`);
  const startWait = Date.now();
  let warned = false;
  while (true) {
    cancel?.check();
    try {
      cancel?.check();
      const ch = await TC.getChallenge(token, challengeId);
      logChallengeSnapshot(log, progressStep, ch);
      const byName: Record<string, any> = {};
      for (const p of (ch.phases || [])) byName[p.name] = p;
      const openOk = mustOpen.every(n => byName[n]?.isOpen === true);
      const closeOk = mustClose.every(n => byName[n]?.isOpen === false);
      if (openOk && closeOk) { log.info('Phase state ok', { mustOpen, mustClose }, getStepProgress(progressStep)); return; }
      // check lateness threshold: 15s after scheduledEndDate for any mustClose phase
      const now = Date.now();
      for (const n of [...mustOpen, ...mustClose]) {
        const p = byName[n];
        if (!p) continue;
        const end = p.scheduledEndDate ? new Date(p.scheduledEndDate).getTime() : null;
        if (end && now > end + 15000 && !warned) {
          log.warn(`Autopilot did not transition '${n}' within 15s of end date`, { phase: n });
          warned = true;
        }
      }
    } catch (e: any) {
      // Ignore 504s or transient errors
      const msg = String(e?.message || e);
      if (!/504/.test(msg)) log.warn('Polling challenge failed; will retry', { error: msg });
    }
    await (cancel ? cancel.wait(10000) : new Promise(r => setTimeout(r, 10000)));
  }
}

async function stepAssignResources(
  log: RunnerLogger,
  token: string,
  cfg: FlowConfig,
  challengeId: string,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  cancel.check();
  log.info('Assigning resources (copilot, screener, reviewers, submitters)...');
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  const lr = readLastRun();
  const reviewerResources = { ...(lr.reviewerResources || {}) } as Record<string, string>;
  let reviewerResourcesChanged = false;
  let challengeResources: { id: string; memberId?: string; memberHandle?: string; roleId?: string }[] | undefined;
  log.info('REQ listResourceRoles');
  log.info('REQ listResourceRoles');
  const roles = await TC.listResourceRoles(token);
  cancel.check();
  log.info('RES listResourceRoles', { count: roles.length });
  log.info('RES listResourceRoles', { count: roles.length });
  log.info('Fetched resource roles', { count: Array.isArray(roles)? roles.length : 0 });
  const roleIdByName: Record<string,string> = {};
  for (const r of roles) roleIdByName[r.name] = r.id;
  const need = {
    Submitter: roleIdByName['Submitter'],
    Reviewer: roleIdByName['Reviewer'],
    Copilot: roleIdByName['Copilot'],
    Screener: roleIdByName['Screener']
  };
  if (!need.Submitter || !need.Reviewer || !need.Copilot || !need.Screener) {
    log.warn('Could not find one or more required resource role IDs', need);
  }
  // Copilot
  if (cfg.copilotHandle) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: cfg.copilotHandle });
    const mem = await TC.getMemberByHandle(token, cfg.copilotHandle);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: cfg.copilotHandle, userId: mem.userId });
    const payload = { challengeId, memberId: String(mem.userId), roleId: need.Copilot };
    log.info('REQ addResource', payload);
    await TC.addResource(token, payload);
    cancel.check();
    log.info('RES addResource', { ok: true });
    log.info('Added copilot', { handle: cfg.copilotHandle });
  }
  // Screener
  if (cfg.screener && need.Screener) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: cfg.screener });
    const mem = await TC.getMemberByHandle(token, cfg.screener);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: cfg.screener, userId: mem.userId });
    const payload = { challengeId, memberId: String(mem.userId), roleId: need.Screener };
    log.info('REQ addResource', payload);
    try {
      await TC.addResource(token, payload);
      cancel.check();
      log.info('RES addResource', { ok: true });
      log.info('Added screener', { handle: cfg.screener });
    } catch (error: any) {
      cancel.check();
      log.warn('Failed to add screener resource (may already exist)', {
        handle: cfg.screener,
        error: error?.message || String(error)
      });
      if (ctx) ctx.recordFailure(error, { requestBody: payload });
    }
  } else if (cfg.screener && !need.Screener) {
    log.warn('Screener handle configured but Screener role ID not found', { handle: cfg.screener });
  }

  // Reviewers
  for (const h of cfg.reviewers) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: h });
    const mem = await TC.getMemberByHandle(token, h);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: h, userId: mem.userId });
    const payload = { challengeId, memberId: String(mem.userId), roleId: need.Reviewer };
    log.info('REQ addResource', payload);
    const added = await TC.addResource(token, payload);
    cancel.check();
    log.info('RES addResource', { ok: true });
    log.info('Added reviewer', { handle: h });
    const resourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : undefined;
    if (resourceId) {
      reviewerResources[h] = resourceId;
      reviewerResourcesChanged = true;
    } else {
      log.warn('Reviewer resource created but no id returned; cannot map resourceId', { handle: h });
    }
  }
  // Submitters
  for (const h of cfg.submitters) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: h });
    const mem = await TC.getMemberByHandle(token, h);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: h, userId: mem.userId });
    const payload = { challengeId, memberId: String(mem.userId), roleId: need.Submitter };
    log.info('REQ addResource', payload);
    await TC.addResource(token, payload);
    cancel.check();
    log.info('RES addResource', { ok: true });
    log.info('Added submitter', { handle: h });
  }

  try {
    cancel.check();
    log.info('REQ listResources', { challengeId });
    const resources = await TC.listResources(token, { challengeId });
    cancel.check();
    const list = Array.isArray(resources) ? resources : [];
    log.info('RES listResources', { count: list.length });
    challengeResources = list.map((res: any) => ({
      id: String(res.id),
      memberId: res.memberId !== undefined ? String(res.memberId) : undefined,
      memberHandle: typeof res.memberHandle === 'string' ? res.memberHandle : undefined,
      roleId: res.roleId !== undefined ? String(res.roleId) : undefined
    }));
    const byHandle = new Map<string, { id: string; roleId?: string }[]>();
    for (const res of challengeResources) {
      if (!res.memberHandle) continue;
      const handleKey = res.memberHandle.toLowerCase();
      if (!byHandle.has(handleKey)) byHandle.set(handleKey, []);
      byHandle.get(handleKey)!.push({ id: res.id, roleId: res.roleId });
    }
    for (const reviewerHandle of cfg.reviewers) {
      const handleKey = reviewerHandle.toLowerCase();
      const entries = byHandle.get(handleKey);
      if (!entries || !entries.length) continue;
      const preferred = entries.find(e => !need.Reviewer || e.roleId === need.Reviewer) || entries[0];
      if (!preferred?.id) continue;
      const current = reviewerResources[reviewerHandle];
      if (current !== preferred.id) {
        reviewerResources[reviewerHandle] = preferred.id;
        reviewerResourcesChanged = true;
      }
    }
  } catch (error: any) {
    log.warn('Failed to fetch challenge resources after assignment', { error: error?.message || String(error) });
  }

  const summary = {
    copilot: cfg.copilotHandle ? 1 : 0,
    screener: cfg.screener ? 1 : 0,
    reviewers: cfg.reviewers.length,
    submitters: cfg.submitters.length
  };
  log.info('Resources assigned', summary, getStepProgress('assignResources'));
  const patch: Record<string, unknown> = {};
  if (challengeResources) patch.challengeResources = challengeResources;
  const roleIdsPatch = Object.fromEntries(Object.entries(need).filter(([, value]) => typeof value === 'string' && value.length > 0));
  if (Object.keys(roleIdsPatch).length) patch.resourceRoleIds = roleIdsPatch;
  if (reviewerResourcesChanged) patch.reviewerResources = reviewerResources;
  if (Object.keys(patch).length) {
    writeLastRun(patch);
  }
}

async function stepCreateSubmissions(
  log: RunnerLogger,
  token: string,
  cfg: FlowConfig,
  challengeId: string,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  const { writeLastRun, readLastRun } = await import('../utils/lastRun.js');

  log.info('Preparing submission artifact from disk', { configuredPath: cfg.submissionZipPath });
  const artifact = await loadSubmissionArtifact(cfg.submissionZipPath);
  cancel.check();
  log.info('Submission artifact ready', { path: artifact.absolutePath, size: artifact.size });

  const lr = readLastRun();
  lr.submissions = lr.submissions || {};
  let createdCount = 0;
  for (const h of cfg.submitters) {
    cancel.check();
    const mem = await TC.getMemberByHandle(token, h);
    cancel.check();
    for (let i = 0; i < cfg.submissionsPerSubmitter; i++) {
      cancel.check();
      const upload = await uploadSubmissionArtifact(log, artifact);
      cancel.check();
      const payload = {
        challengeId,
        memberId: String(mem.userId),
        type: 'CONTEST_SUBMISSION',
        url: upload.url
      };
      log.info('REQ createSubmission', { ...payload, storageKey: upload.key });
      const sub = await TC.createSubmission(token, payload);
      cancel.check();
      log.info('RES createSubmission', { id: sub.id, handle: h, storageKey: upload.key });
      log.info('Submission created', { handle: h, submissionId: sub.id, storageKey: upload.key });
      lr.submissions[h] = lr.submissions[h] || [];
      lr.submissions[h].push(sub.id);
      writeLastRun(lr);
      createdCount += 1;
    }
  }

  log.info('Submissions created', { count: createdCount }, getStepProgress('createSubmissions'));
}

function randPick<T>(arr: T[]): T { return arr[Math.floor(Math.random()*arr.length)]; }

function buildMarkdownReviewItemComment(question: any, answerLabel: string, extraLines: string[] = []): string {
  const rawDescription = typeof question?.description === 'string' ? question.description.trim() : '';
  const description = rawDescription || `Question ${question?.id ?? ''}`.trim() || 'Review item';
  const lines = [
    '### Automated Review Summary',
    '',
    `**Question:** ${description}`,
    `**Recorded Answer:** ${answerLabel}`
  ];
  if (extraLines.length) {
    lines.push('', ...extraLines);
  }
  lines.push(
    '',
    '- Supporting references:',
    '  - [Design spec](https://example.com/design)',
    '  - [Execution logs](https://example.com/logs)',
    '',
    '```bash',
    'npm run verify',
    '```',
    '',
    '#### Attachments',
    '![Evidence 1](https://placehold.co/640x320?text=Evidence+1)',
    '![Evidence 2](https://placehold.co/640x320?text=Evidence+2)',
    '',
    '> _Markdown payload for validation._'
  );
  return lines.join('\n');
}

function buildAppealMarkdown(question: any, submitterHandle: string): string {
  const actor = submitterHandle ? `@${submitterHandle}` : 'the submitter';
  const rawDescription = typeof question?.description === 'string' ? question.description.trim() : '';
  const description = rawDescription || `Question ${question?.id ?? ''}`.trim() || 'review item';
  return [
    `### Appeal from ${actor}`,
    '',
    `**Question:** ${description}`,
    '',
    'During retest we executed `npm run verify` and confirmed the acceptance criteria.',
    '',
    '#### Evidence',
    '- ✅ Steps 1-3 produce the expected output',
    '- ✅ API payload matches the contract',
    '',
    '![Actual Output](https://placehold.co/640x320?text=Actual+Output)',
    '![Expected Output](https://placehold.co/640x320?text=Expected+Output)',
    '',
    '> Please reconsider the deduction based on the attached evidence.'
  ].join('\n');
}

function buildAppealResponseMarkdown(success: boolean, reviewerHandle?: string, question?: any): string {
  const reviewer = reviewerHandle ? `@${reviewerHandle}` : 'Reviewer';
  const rawDescription = typeof question?.description === 'string' ? question.description.trim() : '';
  const description = rawDescription || `Question ${question?.id ?? ''}`.trim() || 'review item';
  const heading = success ? '✅ Appeal Accepted' : '❌ Appeal Rejected';
  const outcomeNote = success
    ? 'Score adjusted upward based on the new evidence.'
    : 'Original score remains unchanged after re-evaluation.';
  return [
    `### ${heading}`,
    '',
    `**Reviewer:** ${reviewer}`,
    `**Question:** ${description}`,
    '',
    '#### Review Notes',
    '- Evidence cross-checked against the design specification',
    '- Automation logs re-run for confirmation',
    '',
    '```bash',
    'npm run audit',
    '```',
    '',
    '![Response Evidence 1](https://placehold.co/640x320?text=Response+Evidence+1)',
    '![Response Evidence 2](https://placehold.co/640x320?text=Response+Evidence+2)',
    '',
    `> ${outcomeNote}`
  ].join('\n');
}
function randInt(min: number, max: number) { return Math.floor(Math.random()*(max-min+1))+min; }

async function stepCreateReviews(
  log: RunnerLogger,
  token: string,
  cfg: FlowConfig,
  challengeId: string,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  log.info('Creating reviews for each submission by each reviewer...');
  log.info('REQ getScorecard', { scorecardId: cfg.scorecardId });
  const scorecard = await TC.getScorecard(token, cfg.scorecardId);
  cancel.check();
  log.info('RES getScorecard', { id: scorecard.id, groups: (scorecard.scorecardGroups||[]).length });
  const groups = scorecard.scorecardGroups || [];
  const questions: any[] = [];
  for (const g of groups) for (const s of (g.sections||[])) for (const q of (s.questions||[])) questions.push(q);

  log.info('REQ listReviews', { challengeId });
  const listResponse = await TC.listReviews(token, challengeId);
  cancel.check();
  const responseData = Array.isArray(listResponse)
    ? listResponse
    : Array.isArray((listResponse as any)?.data)
      ? (listResponse as any).data
      : [];
  const existingReviews = responseData;
  const totalReviews = typeof (listResponse as any)?.meta?.totalCount === 'number'
    ? (listResponse as any).meta.totalCount
    : existingReviews.length;
  const pendingReviewMap = new Map<string, any>();
  for (const review of existingReviews) {
    const status = typeof review?.status === 'string' ? review.status.toUpperCase() : '';
    if (status === 'PENDING' || status === 'IN_PROGRESS') {
      const resourceId = review?.resourceId !== undefined ? String(review.resourceId) : undefined;
      const submissionId = review?.submissionId !== undefined ? String(review.submissionId) : undefined;
      if (resourceId && submissionId) {
        const key = `${resourceId}:${submissionId}`;
        if (!pendingReviewMap.has(key)) {
          pendingReviewMap.set(key, review);
        }
      }
    }
  }
  log.info('RES listReviews', { total: totalReviews, fetched: existingReviews.length, pending: pendingReviewMap.size });

  // Gather reviewer resource IDs by handle (reuse roles fetch)
  log.info('REQ listResourceRoles');
  log.info('REQ listResourceRoles');
  const roles = await TC.listResourceRoles(token);
  cancel.check();
  log.info('RES listResourceRoles', { count: roles.length });
  log.info('RES listResourceRoles', { count: roles.length });
  log.info('Fetched resource roles', { count: Array.isArray(roles)? roles.length : 0 });
  const reviewerRole = (roles.find((r:any)=>r.name==='Reviewer')||{}).id;
  const submitterRole = (roles.find((r:any)=>r.name==='Submitter')||{}).id;

  const lr = readLastRun();
  const reviewerResourceMap = lr.reviewerResources || {};
  const reviewerResources: { handle: string, resourceId: string }[] = [];
  for (const h of cfg.reviewers) {
    cancel.check();
    const resourceId = reviewerResourceMap[h];
    if (!resourceId) {
      log.warn('No reviewer resource ID recorded; skipping reviewer for review creation', { reviewer: h });
      continue;
    }
    reviewerResources.push({ handle: h, resourceId });
  }
  if (!reviewerResources.length) {
    log.warn('No reviewer resources available; skipping review creation');
    return { reviews: [], questions };
  }

  // Fetch submissions list via reviews API doesn't expose; we tracked submission IDs when created, but for this simple flow we assume known via listReviews later. To keep moving, we ask the challenge to fetch submissions is not provided; so we manufacture by re-submitting map. In production, persist submission IDs when creating them.
  // Here we won't have them; in real run stepCreateSubmissions logs submission IDs; user can proceed in one run.
  // For demo completeness, we'll create one artificial map to proceed; adjust to your needs.

  const updated: any[] = [];
  for (const submitterHandle of cfg.submitters) {
    cancel.check();
    const mem = await TC.getMemberByHandle(token, submitterHandle);
    cancel.check();
    const subIds = (lr.submissions && lr.submissions[submitterHandle]) || [];
    if (!subIds.length) {
      log.warn('No submission IDs recorded for submitter; skipping', { submitterHandle });
      continue;
    }
    for (const submissionId of subIds) {
      cancel.check();
      for (const rev of reviewerResources) {
        cancel.check();
        const pendingReviewKey = `${rev.resourceId}:${submissionId}`;
        const pendingReview = pendingReviewMap.get(pendingReviewKey);
        if (!pendingReview) {
          log.warn('No pending review found; skipping patch', {
            reviewer: rev.handle,
            resourceId: rev.resourceId,
            submitter: submitterHandle,
            submissionId
          });
          continue;
        }
        const reviewIdRaw = pendingReview?.id;
        const reviewId = reviewIdRaw !== undefined ? String(reviewIdRaw) : undefined;
        if (!reviewId) {
          log.warn('Pending review missing id; skipping patch', {
            reviewer: rev.handle,
            resourceId: rev.resourceId,
            submitter: submitterHandle,
            submissionId
          });
          continue;
        }
        const existingItems = Array.isArray(pendingReview.reviewItems) ? pendingReview.reviewItems : [];
        const itemsByQuestion = new Map<string, any>(existingItems
          .filter((item: any) => item && item.scorecardQuestionId !== undefined)
          .map((item: any) => [String(item.scorecardQuestionId), item])
        );
        const reviewItems = questions.map(q => {
          if (q.type === 'YES_NO') {
            const existingItem = itemsByQuestion.get(String(q.id));
            const answer = randPick(['YES', 'NO']);
            const commentContent = buildMarkdownReviewItemComment(q, answer, [
              '#### Checklist',
              '- [x] Regression suite executed',
              '- [ ] Manual QA sign-off pending',
              '',
              '`Tracking ID:` `auto-review-yes-no`'
            ]);
            const payload: any = {
              scorecardQuestionId: q.id,
              initialAnswer: answer,
              reviewItemComments: [{
                content: commentContent,
                type: randPick(['COMMENT', 'REQUIRED', 'RECOMMENDED']),
                sortOrder: 1
              }]
            };
            if (existingItem?.id !== undefined) payload.id = existingItem.id;
            return payload;
          } else if (q.type === 'SCALE') {
            const existingItem = itemsByQuestion.get(String(q.id));
            const min = typeof q.scaleMin === 'number' ? q.scaleMin : 1;
            const max = typeof q.scaleMax === 'number' ? q.scaleMax : 10;
            const value = String(randInt(min, max));
            const commentContent = buildMarkdownReviewItemComment(q, value, [
              `**Scale Range:** ${min} – ${max}`,
              '- _Higher scores indicate stronger coverage._',
              '`Metric:` `performance-index`'
            ]);
            const payload: any = {
              scorecardQuestionId: q.id,
              initialAnswer: value,
              reviewItemComments: [{
                content: commentContent,
                type: randPick(['COMMENT', 'REQUIRED', 'RECOMMENDED']),
                sortOrder: 1
              }]
            };
            if (existingItem?.id !== undefined) payload.id = existingItem.id;
            return payload;
          } else {
            const existingItem = itemsByQuestion.get(String(q.id));
            const fallbackAnswer = 'YES';
            const commentContent = buildMarkdownReviewItemComment(q, fallbackAnswer, [
              '*Fallback evaluation applied for non-standard question type.*',
              '`Tracking ID:` `auto-review-generic`'
            ]);
            const payload: any = {
              scorecardQuestionId: q.id,
              initialAnswer: fallbackAnswer,
              reviewItemComments: [{ content: commentContent, type: 'COMMENT', sortOrder: 1 }]
            };
            if (existingItem?.id !== undefined) payload.id = existingItem.id;
            return payload;
          }
        });

        const payload = {
          scorecardId: pendingReview?.scorecardId || cfg.scorecardId,
          typeId: pendingReview?.typeId || 'REVIEW',
          metadata: pendingReview?.metadata || {},
          status: 'COMPLETED',
          reviewDate: dayjs().toISOString(),
          committed: true,
          reviewItems
        };

        try {
          log.info('REQ patchReview', { reviewId, payload });
          const r = await TC.updateReview(token, reviewId, payload);
          cancel.check();
          log.info('RES patchReview', { reviewId });
          const reviewRecord = {
            ...r,
            resourceId: r?.resourceId ?? rev.resourceId,
            reviewerHandle: rev.handle
          };
          updated.push(reviewRecord);
          const key = `${rev.handle}:${submitterHandle}:${submissionId}`;
          const reviews = { ...(lr.reviews||{}), [key]: r.id };
          writeLastRun({ reviews });
          pendingReviewMap.delete(pendingReviewKey);
          log.info('Patched review', { reviewer: rev.handle, submitter: submitterHandle, submissionId, reviewId });
        } catch (e:any) {
          log.warn('Patch review failed (check submissionId/phaseId requirements in your env)', { reviewer: rev.handle, submitter: submitterHandle, submissionId, reviewId, error: e?.message || String(e) });
          ctx?.recordFailure(e, { requestBody: payload });
        }
      }
    }
  }
  log.info('Reviews patched', { count: updated.length }, getStepProgress('createReviews'));
  return { reviews: updated, questions };
}

async function stepCreateAppeals(
  log: RunnerLogger,
  token: string,
  cfg: FlowConfig,
  reviewInfo: any,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  const { writeLastRun, readLastRun } = await import('../utils/lastRun.js');
  log.info('Creating random appeals for review items...');
  const appeals: any[] = [];
  const questionsById = new Map<string, any>(
    Array.isArray(reviewInfo?.questions)
      ? reviewInfo.questions
          .filter((q: any) => q && (q.id !== undefined))
          .map((q: any) => [String(q.id), q] as [string, any])
      : []
  );
  const lr = readLastRun();
  const ap: string[] = lr.appeals || [];
  const challengeId = lr.challengeId;
  const appealedCommentIdsFromLastRun = Array.isArray(lr.appealedCommentIds)
    ? lr.appealedCommentIds.filter((id: unknown): id is string => typeof id === 'string')
    : [];
  const appealedCommentIds = new Set<string>(appealedCommentIdsFromLastRun);

  const normalizeResources = (list: any[]) => (Array.isArray(list) ? list : []).map((res: any) => ({
    id: res?.id !== undefined ? String(res.id) : undefined,
    memberId: res?.memberId !== undefined ? String(res.memberId) : undefined,
    memberHandle: typeof res?.memberHandle === 'string' ? res.memberHandle : undefined,
    roleId: res?.roleId !== undefined ? String(res.roleId) : undefined
  })).filter((res: any) => typeof res.id === 'string');

  let challengeResources = normalizeResources(lr.challengeResources || []);
  const roleIds = { ...(lr.resourceRoleIds || {}) } as Record<string, string>;
  const patch: Record<string, unknown> = {};

  if ((!challengeResources.length) && challengeId) {
    try {
      cancel.check();
      log.info('REQ listResources', { challengeId });
      const resources = await TC.listResources(token, { challengeId });
      cancel.check();
      const list = Array.isArray(resources) ? resources : [];
      log.info('RES listResources', { count: list.length });
      challengeResources = normalizeResources(list);
      patch.challengeResources = challengeResources;
    } catch (error: any) {
      log.warn('Failed to load challenge resources for appeals', { error: error?.message || String(error) });
    }
  }

  if (!roleIds.Submitter) {
    try {
      cancel.check();
      log.info('REQ listResourceRoles');
      const roles = await TC.listResourceRoles(token);
      cancel.check();
      log.info('RES listResourceRoles', { count: roles.length });
      for (const role of (Array.isArray(roles) ? roles : [])) {
        if (role && typeof role.name === 'string' && typeof role.id === 'string') {
          roleIds[role.name] = role.id;
        }
      }
      if (roleIds.Submitter) {
        patch.resourceRoleIds = roleIds;
      }
    } catch (error: any) {
      log.warn('Failed to refresh resource role IDs for appeals', { error: error?.message || String(error) });
    }
  }

  if (!challengeResources.length) {
    log.warn('No challenge resources available; appeals may not be created');
  }

  const resourcesByHandle = new Map<string, { id: string; roleId?: string }[]>();
  for (const res of challengeResources) {
    if (!res.memberHandle || !res.id) continue;
    const key = res.memberHandle.toLowerCase();
    if (!resourcesByHandle.has(key)) resourcesByHandle.set(key, []);
    resourcesByHandle.get(key)!.push({ id: res.id, roleId: res.roleId });
  }

  const submitterRoleId = roleIds.Submitter;

  const getResourceIdForHandle = (handle: string) => {
    if (!handle) return undefined;
    const entries = resourcesByHandle.get(handle.toLowerCase());
    if (!entries || !entries.length) return undefined;
    const matchByRole = submitterRoleId ? entries.find(e => e.roleId === submitterRoleId) : undefined;
    return (matchByRole ?? entries[0])?.id;
  };

  if (Object.keys(patch).length) {
    writeLastRun(patch);
  }
  // Attempt at most one appeal per review item comment id, but we need comment IDs from created reviews
  for (const r of reviewInfo.reviews) {
    cancel.check();
    for (const item of (r.reviewItems || [])) {
      cancel.check();
      for (const c of (item.reviewItemComments || [])) {
        cancel.check();
        const commentId = c?.id !== undefined ? String(c.id) : undefined;
        if (!commentId) continue;
        if (appealedCommentIds.has(commentId)) {
          log.info('Skipping appeal creation for already appealed comment', { reviewItemCommentId: commentId });
          continue;
        }
        const shouldCreateAppeal = randInt(0, 1) === 1;
        if (!shouldCreateAppeal) continue;
        // Pick a random submitter as the appellant
        const submitterHandle = cfg.submitters[randInt(0, Math.max(0, cfg.submitters.length-1))] || '';
        if (!submitterHandle) continue;
        const resourceId = getResourceIdForHandle(submitterHandle);
        if (!resourceId) {
          log.warn('No challenge resource found for submitter; skipping appeal creation', { submitterHandle });
          continue;
        }
        const question = questionsById.get(String(item?.scorecardQuestionId ?? ''));
        const content = buildAppealMarkdown(question, submitterHandle);
        const payload = {
          resourceId,
          reviewItemCommentId: commentId,
          content
        };
        try {
          log.info('REQ createAppeal', payload);
          const a = await TC.createAppeal(token, payload);
          cancel.check();
          log.info('RES createAppeal', a);
          appeals.push({ appeal: a, review: r, reviewItem: item, question });
          appealedCommentIds.add(commentId);
          ap.push(a.id);
          writeLastRun({ appeals: ap, appealedCommentIds: Array.from(appealedCommentIds) });
          log.info('Appeal created', { appealId: a.id, by: submitterHandle });
        } catch (e:any) {
          log.warn('Create appeal failed', { error: e?.message || String(e) });
          appealedCommentIds.add(commentId);
          writeLastRun({ appealedCommentIds: Array.from(appealedCommentIds) });
          ctx?.recordFailure(e, { requestBody: payload });
        }
      }
    }
  }
  log.info('Appeals created', { count: appeals.length }, getStepProgress('createAppeals'));
  return appeals;
}

async function stepAppealResponses(
  log: RunnerLogger,
  token: string,
  cfg: FlowConfig,
  appeals: any[],
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  log.info('Creating appeal responses and updating scores when successful...');
  const lr = readLastRun();
  const challengeId = lr.challengeId;
  const normalizeResources = (list: any[]) => (Array.isArray(list) ? list : []).map((res: any) => ({
    id: res?.id !== undefined ? String(res.id) : undefined,
    memberId: res?.memberId !== undefined ? String(res.memberId) : undefined,
    memberHandle: typeof res?.memberHandle === 'string' ? res.memberHandle : undefined,
    roleId: res?.roleId !== undefined ? String(res.roleId) : undefined
  })).filter((res: any) => typeof res.id === 'string');

  let challengeResources = normalizeResources(lr.challengeResources || []);
  const roleIds = { ...(lr.resourceRoleIds || {}) } as Record<string, string>;
  const patch: Record<string, unknown> = {};

  if ((!challengeResources.length) && challengeId) {
    try {
      cancel.check();
      log.info('REQ listResources', { challengeId });
      const resources = await TC.listResources(token, { challengeId });
      cancel.check();
      const list = Array.isArray(resources) ? resources : [];
      log.info('RES listResources', { count: list.length });
      challengeResources = normalizeResources(list);
      patch.challengeResources = challengeResources;
    } catch (error: any) {
      log.warn('Failed to load challenge resources for appeal responses', { error: error?.message || String(error) });
    }
  }

  if (!roleIds.Reviewer) {
    try {
      cancel.check();
      log.info('REQ listResourceRoles');
      const roles = await TC.listResourceRoles(token);
      cancel.check();
      log.info('RES listResourceRoles', { count: roles.length });
      for (const role of (Array.isArray(roles) ? roles : [])) {
        if (role && typeof role.name === 'string' && typeof role.id === 'string') {
          roleIds[role.name] = role.id;
        }
      }
      if (roleIds.Reviewer) {
        patch.resourceRoleIds = roleIds;
      }
    } catch (error: any) {
      log.warn('Failed to refresh resource role IDs for appeal responses', { error: error?.message || String(error) });
    }
  }

  if (Object.keys(patch).length) {
    writeLastRun(patch);
  }

  const resourcesByHandle = new Map<string, { id: string; roleId?: string }[]>();
  for (const res of challengeResources) {
    if (!res.memberHandle || !res.id) continue;
    const key = res.memberHandle.toLowerCase();
    if (!resourcesByHandle.has(key)) resourcesByHandle.set(key, []);
    resourcesByHandle.get(key)!.push({ id: res.id, roleId: res.roleId });
  }

  const reviewerRoleId = roleIds.Reviewer;

  const getReviewerResourceId = (review: any) => {
    if (!review) return undefined;
    if (review.resourceId) return String(review.resourceId);
    if (review.reviewerHandle) {
      const entries = resourcesByHandle.get(String(review.reviewerHandle).toLowerCase());
      if (entries && entries.length) {
        const matchByRole = reviewerRoleId ? entries.find(e => e.roleId === reviewerRoleId) : undefined;
        return (matchByRole ?? entries[0])?.id;
      }
    }
    return undefined;
  };

  const toNumber = (value: unknown) => {
    if (value === null || value === undefined) return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  };

  for (const entry of appeals) {
    cancel.check();
    const success = Math.random() < 0.5;

    const responseContent = buildAppealResponseMarkdown(success, entry.review?.reviewerHandle, entry.question);
    let reviewerResourceId: string | undefined;
    try {
      reviewerResourceId = getReviewerResourceId(entry.review);
      if (!reviewerResourceId) {
        log.warn('No reviewer resourceId found for appeal response; skipping', { appealId: entry.appeal?.id, reviewerHandle: entry.review?.reviewerHandle });
        continue;
      }
      const payload = {
        appealId: entry.appeal.id,
        resourceId: reviewerResourceId, // reviewer responding
        content: responseContent,
        success
      };
      log.info('REQ respondToAppeal', payload);
      await TC.respondToAppeal(token, entry.appeal.id, payload);
      cancel.check();
      log.info('RES respondToAppeal', { ok: true, appealId: entry.appeal.id });
      log.info('Appeal response posted', { appealId: entry.appeal.id, success });

      const reviewItem = entry.reviewItem;
      const reviewItemId = reviewItem?.id !== undefined ? String(reviewItem.id) : undefined;
      const reviewId = entry.review?.id !== undefined ? String(entry.review.id) : undefined;
      const scorecardQuestionId = reviewItem?.scorecardQuestionId !== undefined ? String(reviewItem.scorecardQuestionId) : undefined;
      const initialAnswerRaw = reviewItem?.initialAnswer ?? reviewItem?.finalAnswer;

      if (!reviewItemId || !reviewId || !scorecardQuestionId || initialAnswerRaw === undefined) {
        log.warn('Missing review item details; skipping review item update after appeal response', {
          appealId: entry.appeal?.id,
          reviewItemId,
          reviewId,
          scorecardQuestionId,
          hasInitialAnswer: initialAnswerRaw !== undefined
        });
        continue;
      }

      const initialAnswer = String(initialAnswerRaw);
      const existingFinalAnswer = reviewItem?.finalAnswer !== undefined ? String(reviewItem.finalAnswer) : undefined;
      const question = entry.question;

      let finalAnswer = existingFinalAnswer ?? initialAnswer;
      if (success) {
        const questionType = typeof question?.type === 'string' ? question.type.toUpperCase() : undefined;
        if (questionType === 'YES_NO') {
          const normalizedInitial = initialAnswer.trim().toUpperCase();
          finalAnswer = normalizedInitial === 'NO' ? 'YES' : (normalizedInitial || 'YES');
        } else {
          const initialNumeric = toNumber(initialAnswer);
          const existingFinalNumeric = existingFinalAnswer !== undefined ? toNumber(existingFinalAnswer) : undefined;
          const scaleMaxNumeric = toNumber(question?.scaleMax ?? reviewItem?.scaleMax);
          if (initialNumeric !== undefined) {
            let target = existingFinalNumeric !== undefined && existingFinalNumeric > initialNumeric
              ? existingFinalNumeric
              : initialNumeric + 1;
            if (scaleMaxNumeric !== undefined) {
              target = Math.min(target, scaleMaxNumeric);
            }
            if (scaleMaxNumeric !== undefined && target > scaleMaxNumeric) {
              target = scaleMaxNumeric;
            }
            if (target < initialNumeric) {
              target = scaleMaxNumeric !== undefined ? Math.min(scaleMaxNumeric, initialNumeric + 1) : initialNumeric;
            }
            finalAnswer = String(target);
          } else {
            finalAnswer = initialAnswer;
          }
        }
      } else if (!existingFinalAnswer) {
        finalAnswer = initialAnswer;
      }

      const reviewItemPayload = {
        scorecardQuestionId,
        initialAnswer,
        finalAnswer,
        reviewId
      };

      try {
        cancel.check();
        log.info('REQ patchReviewItem', { reviewItemId, payload: reviewItemPayload });
        await TC.updateReviewItem(token, reviewItemId, reviewItemPayload);
        cancel.check();
        log.info('Review item updated', { reviewItemId, reviewId, finalAnswer });
      } catch (e: any) {
        log.warn('Failed to update review item', { error: e?.message || String(e) });
        ctx?.recordFailure(e, { requestBody: { reviewItemId, ...reviewItemPayload } });
      }
    } catch (e:any) {
      log.warn('Appeal response failed', { error: e?.message || String(e) });
      ctx?.recordFailure(e, { requestBody: { appealId: entry.appeal.id, resourceId: reviewerResourceId, content: responseContent, success } });
    }
  }
  log.info('Appeal responses processed', { count: appeals.length }, getStepProgress('appealResponses'));
}

async function stepAwaitAllClosed(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  log.info('Waiting for all phases to be closed...');
  while (true) {
    cancel.check();
    const ch = await TC.getChallenge(token, challengeId);
    logChallengeSnapshot(log, 'awaitAllClosed', ch);
    cancel.check();
    const allClosed = (ch.phases || []).every((p:any) => p.isOpen === false);
    if (allClosed) { log.info('All phases are closed', undefined, getStepProgress('awaitAllClosed')); return; }
    await (cancel ? cancel.wait(10000) : new Promise(r => setTimeout(r, 10000)));
  }
}

async function stepAwaitCompletion(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers,
  ctx?: StepContext
) {
  log.info('Waiting for challenge to reach COMPLETED and winners set...');
  while (true) {
    cancel.check();
    const ch = await TC.getChallenge(token, challengeId);
    logChallengeSnapshot(log, 'awaitCompletion', ch);
    cancel.check();
    if (ch.status === 'COMPLETED' && Array.isArray(ch.winners) && ch.winners.length > 0) {
      log.info('Challenge completed with winners', { winners: ch.winners }, getStepProgress('awaitCompletion'));
      return;
    }
    // As a fallback, we can derive winners by fetching reviews and checking scores.
    await (cancel ? cancel.wait(10000) : new Promise(r => setTimeout(r, 10000)));
  }
}
