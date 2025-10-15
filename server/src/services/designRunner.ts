import dayjs from 'dayjs';
import { nanoid } from 'nanoid';
import { RunnerLogger, type StepRequestLog, type StepStatus } from '../utils/logger.js';
import { setActiveStepRequestRecorder, type StepRequestLogInput } from '../utils/stepRequestRecorder.js';
import { getToken, TC } from './topcoder.js';
import { loadSubmissionArtifact, uploadSubmissionArtifact } from './submissionUploader.js';
import type { DesignConfig } from '../types/config.js';

export type RunMode = 'full' | 'toStep';

export type StepName =
  | 'token'
  | 'createChallenge'
  | 'updateDraft'
  | 'activate'
  | 'awaitRegCkptOpen'
  | 'assignResources'
  | 'createCheckpointSubmissions'
  | 'awaitCheckpointScreeningOpen'
  | 'createCheckpointScreeningReviews'
  | 'awaitCheckpointReviewOpen'
  | 'createCheckpointReviews'
  | 'awaitSubmissionOpen'
  | 'createSubmissions'
  | 'awaitScreeningOpen'
  | 'createScreeningReviews'
  | 'awaitReviewOpen'
  | 'createReviews'
  | 'awaitApprovalOpen'
  | 'createApprovalReview'
  | 'awaitAllClosed'
  | 'awaitCompletion';

const STEPS: StepName[] = [
  'token',
  'createChallenge',
  'updateDraft',
  'activate',
  'awaitRegCkptOpen',
  'assignResources',
  'createCheckpointSubmissions',
  'awaitCheckpointScreeningOpen',
  'createCheckpointScreeningReviews',
  'awaitCheckpointReviewOpen',
  'createCheckpointReviews',
  'awaitSubmissionOpen',
  'createSubmissions',
  'awaitScreeningOpen',
  'createScreeningReviews',
  'awaitReviewOpen',
  'createReviews',
  'awaitApprovalOpen',
  'createApprovalReview',
  'awaitAllClosed',
  'awaitCompletion'
];

const PROGRESS_STEPS: StepName[] = STEPS.filter(step => step !== 'token');

function getStepProgress(step: StepName): number | undefined {
  const idx = PROGRESS_STEPS.indexOf(step);
  if (idx === -1) return undefined;
  const value = ((idx + 1) / PROGRESS_STEPS.length) * 100;
  return Number(value.toFixed(2));
}

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
        try { check(); } catch (err) { reject(err); return; }
      }
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { cleanup(); reject(cancellationError()); };
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
      signal.addEventListener('abort', onAbort);
    });
  };

  return { check, wait };
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
  try { return JSON.parse(data); } catch { return data; }
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
  return {
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
}

function maybeStop(mode: RunMode, toStep: StepName|undefined, current: StepName, log: RunnerLogger) {
  if (mode === 'toStep' && toStep === current) {
    log.info(`Stopping at step '${current}' as requested`, { step: current }, 100);
    throw new Error('__STOP_EARLY__');
  }
}

function logChallengeSnapshot(log: RunnerLogger, stage: string, challenge: any) {
  log.info('Challenge refresh', { stage, challenge });
}

function toStringId(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

type ReviewTypeRecord = {
  id?: string;
  name?: string;
  isActive?: boolean;
};

let cachedReviewTypeLookup: Map<string, { id: string; name: string }> | null = null;
let reviewTypeLookupPromise: Promise<Map<string, { id: string; name: string }>> | null = null;
let reviewTypeLookupLogged = false;
const missingReviewTypeWarnings = new Set<string>();

function normalizeReviewTypeResponse(data: any): ReviewTypeRecord[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result?.content)) return data.result.content;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.result?.data)) return data.result.data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function loadActiveReviewTypeLookup(
  log: RunnerLogger,
  token: string,
  cancel: CancellationHelpers
): Promise<Map<string, { id: string; name: string }>> {
  if (cachedReviewTypeLookup) return cachedReviewTypeLookup;
  if (reviewTypeLookupPromise) return reviewTypeLookupPromise;

  reviewTypeLookupPromise = (async () => {
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      cancel.check();
      try {
        if (attempt === 0 && !reviewTypeLookupLogged) {
          log.info('Loading review types from API...');
        }
        const response = await TC.listReviewTypes(token, { perPage: 100 });
        cancel.check();
        const normalized = normalizeReviewTypeResponse(response);
        const lookup = new Map<string, { id: string; name: string }>();
        for (const item of normalized) {
          if (!item || item.isActive !== true) continue;
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          const id = toStringId(item.id);
          if (!name || !id) continue;
          const key = name.toLowerCase();
          if (!lookup.has(key)) lookup.set(key, { id, name });
        }
        if (!reviewTypeLookupLogged) {
          log.info('Active review types loaded', { count: lookup.size });
          reviewTypeLookupLogged = true;
        }
        cachedReviewTypeLookup = lookup;
        return lookup;
      } catch (error: any) {
        log.warn('Failed to load review types', {
          attempt: attempt + 1,
          error: error?.message || String(error)
        });
      }
      if (attempt < attempts - 1) await cancel.wait(500);
    }
    cachedReviewTypeLookup = new Map();
    return cachedReviewTypeLookup;
  })();

  try {
    return await reviewTypeLookupPromise;
  } finally {
    reviewTypeLookupPromise = null;
  }
}

async function resolveReviewTypeIdForPhase(
  log: RunnerLogger,
  token: string,
  cancel: CancellationHelpers,
  phaseNameHints: string[]
): Promise<string | undefined> {
  const candidates = phaseNameHints
    .map(name => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean);
  if (!candidates.length) return undefined;

  const lookup = await loadActiveReviewTypeLookup(log, token, cancel);
  for (const candidate of candidates) {
    const entry = lookup.get(candidate.toLowerCase());
    if (entry) return entry.id;
  }

  const key = candidates.map(c => c.toLowerCase()).join('|') || '::none';
  if (!missingReviewTypeWarnings.has(key)) {
    const hasEntries = lookup.size > 0;
    log.warn(
      hasEntries
        ? 'No matching active review type found for phase names'
        : 'No active review types available to match phase names',
      {
        phaseCandidates: candidates,
        activeReviewTypeNames: hasEntries ? Array.from(lookup.values()).map(entry => entry.name) : []
      }
    );
    missingReviewTypeWarnings.add(key);
  }
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
    if (attempt < 2) await cancel.wait(500);
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
      entry = { id, outcome: detail.outcome ?? 'success', timestamp: detail.timestamp ?? new Date().toISOString() };
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
      const detail: StepRequestLogInput = { ...base, ...(overrides ?? {}), id: overrides?.id ?? errorRequestId ?? base.id, outcome: 'failure' };
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

export async function runDesignFlow(
  cfg: DesignConfig,
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
  const token = await withStep(log, 'token', () => stepToken(log, cancel));
  cancel.check();
  maybeStop(mode, toStep, 'token', log);
  const challenge = await withStep(log, 'createChallenge', () => stepCreateChallenge(log, token, cfg, cancel));
  writeLastRun({ challengeId: challenge.id, challengeName: challenge.name });
  cancel.check();
  maybeStop(mode, toStep, 'createChallenge', log);
  await withStep(log, 'updateDraft', () => stepUpdateDraft(log, token, cfg, challenge.id, cancel));
  maybeStop(mode, toStep, 'updateDraft', log);
  cancel.check();
  await withStep(log, 'activate', () => stepActivate(log, token, challenge.id, cancel));
  maybeStop(mode, toStep, 'activate', log);

  await withStep(log, 'awaitRegCkptOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Registration', 'Checkpoint Submission'], 'awaitRegCkptOpen', [], cancel));
  maybeStop(mode, toStep, 'awaitRegCkptOpen', log);
  cancel.check();
  await withStep(log, 'assignResources', () => stepAssignResources(log, token, cfg, challenge.id, cancel));
  maybeStop(mode, toStep, 'assignResources', log);
  cancel.check();
  await withStep(log, 'createCheckpointSubmissions', () => stepCreateSubmissionsInternal(log, token, cfg, challenge.id, 'CHECKPOINT_SUBMISSION', 'createCheckpointSubmissions', cancel));
  maybeStop(mode, toStep, 'createCheckpointSubmissions', log);

  await withStep(log, 'awaitCheckpointScreeningOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Checkpoint Screening'], 'awaitCheckpointScreeningOpen', ['Registration', 'Checkpoint Submission'], cancel));
  maybeStop(mode, toStep, 'awaitCheckpointScreeningOpen', log);
  cancel.check();
  await withStep(log, 'createCheckpointScreeningReviews', () => stepPatchPendingReviews(
    log,
    token,
    cfg,
    challenge.id,
    'createCheckpointScreeningReviews',
    cfg.checkpointScreeningScorecardId || cfg.screeningScorecardId || cfg.scorecardId,
    cfg.checkpointScreener || cfg.screener || cfg.screeningReviewer || cfg.reviewer,
    'checkpointSubmissions',
    ['Checkpoint Screening'],
    cancel
  ));
  maybeStop(mode, toStep, 'createCheckpointScreeningReviews', log);

  await withStep(log, 'awaitCheckpointReviewOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Checkpoint Review'], 'awaitCheckpointReviewOpen', ['Registration', 'Checkpoint Submission', 'Checkpoint Screening'], cancel));
  maybeStop(mode, toStep, 'awaitCheckpointReviewOpen', log);
  cancel.check();
  await withStep(log, 'createCheckpointReviews', () => stepPatchPendingReviews(
    log,
    token,
    cfg,
    challenge.id,
    'createCheckpointReviews',
    cfg.checkpointReviewScorecardId || cfg.checkpointScorecardId,
    cfg.checkpointReviewer || cfg.reviewer,
    'checkpointSubmissions',
    ['Checkpoint Review'],
    cancel
  ));
  maybeStop(mode, toStep, 'createCheckpointReviews', log);

  await withStep(log, 'awaitSubmissionOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Submission'], 'awaitSubmissionOpen', ['Checkpoint Review'], cancel));
  maybeStop(mode, toStep, 'awaitSubmissionOpen', log);
  cancel.check();
  await withStep(log, 'createSubmissions', () => stepCreateSubmissionsInternal(log, token, cfg, challenge.id, 'CONTEST_SUBMISSION', 'createSubmissions', cancel));
  maybeStop(mode, toStep, 'createSubmissions', log);

  await withStep(log, 'awaitScreeningOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Screening'], 'awaitScreeningOpen', ['Submission'], cancel));
  maybeStop(mode, toStep, 'awaitScreeningOpen', log);
  cancel.check();
  await withStep(log, 'createScreeningReviews', () => stepPatchPendingReviews(
    log,
    token,
    cfg,
    challenge.id,
    'createScreeningReviews',
    cfg.screeningScorecardId || cfg.scorecardId,
    cfg.screener || cfg.screeningReviewer || cfg.reviewer,
    'submissions',
    ['Screening'],
    cancel
  ));
  maybeStop(mode, toStep, 'createScreeningReviews', log);

  await withStep(log, 'awaitReviewOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Review'], 'awaitReviewOpen', ['Screening'], cancel));
  maybeStop(mode, toStep, 'awaitReviewOpen', log);
  cancel.check();
  await withStep(log, 'createReviews', () => stepPatchPendingReviews(
    log,
    token,
    cfg,
    challenge.id,
    'createReviews',
    cfg.reviewScorecardId || cfg.scorecardId,
    cfg.reviewer,
    'submissions',
    ['Iterative Review', 'Review'],
    cancel
  ));
  maybeStop(mode, toStep, 'createReviews', log);

  await withStep(log, 'awaitApprovalOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Approval'], 'awaitApprovalOpen', ['Review'], cancel));
  maybeStop(mode, toStep, 'awaitApprovalOpen', log);
  cancel.check();
  await withStep(log, 'createApprovalReview', () => stepApprovalFlow(log, token, cfg, challenge.id, cancel));
  maybeStop(mode, toStep, 'createApprovalReview', log);

  await withStep(log, 'awaitAllClosed', () => stepAwaitAllClosed(log, token, challenge.id, cancel));
  maybeStop(mode, toStep, 'awaitAllClosed', log);
  cancel.check();
  await withStep(log, 'awaitCompletion', () => stepAwaitCompletion(log, token, challenge.id, cancel));
  log.info('Design Challenge flow complete', { challengeId: challenge.id }, 100);
}

async function stepToken(log: RunnerLogger, cancel: CancellationHelpers) {
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
  cfg: DesignConfig,
  cancel: CancellationHelpers
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
    description: 'Design Challenge end-to-end test',
    discussions: [
      { name: `${challengeName} Discussion`, type: 'CHALLENGE', provider: 'vanilla' }
    ],
    metadata: [
      {
        name: 'submissionLimit',
        value: '{"unlimited":"true","limit":"false","count":""}'
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
  cfg: DesignConfig,
  challengeId: string,
  cancel: CancellationHelpers
) {
  cancel.check();
  log.info('Updating challenge to DRAFT with design-specific reviewers...');

  // Resolve needed phase IDs
  const reviewPhaseId = await resolvePhaseIdByName(log, token, challengeId, 'Review', cancel);
  const checkpointReviewPhaseId = await resolvePhaseIdByName(log, token, challengeId, 'Checkpoint Review', cancel);
  const checkpointScreeningPhaseId = await resolvePhaseIdByName(log, token, challengeId, 'Checkpoint Screening', cancel);
  const screeningPhaseId = await resolvePhaseIdByName(log, token, challengeId, 'Screening', cancel);
  const approvalPhaseId = await resolvePhaseIdByName(log, token, challengeId, 'Approval', cancel);

  const nowIso = dayjs().toISOString();
  const reviewers: any[] = [];
  if (reviewPhaseId) {
    reviewers.push({
      scorecardId: cfg.reviewScorecardId || cfg.scorecardId,
      isMemberReview: true,
      memberReviewerCount: 1,
      phaseId: reviewPhaseId,
      baseCoefficient: 0.13,
      incrementalCoefficient: 0.2,
      type: 'REGULAR_REVIEW'
    });
  }
  if (checkpointReviewPhaseId) {
    reviewers.push({
      scorecardId: cfg.checkpointReviewScorecardId || cfg.checkpointScorecardId,
      isMemberReview: true,
      memberReviewerCount: 1,
      phaseId: checkpointReviewPhaseId,
      baseCoefficient: 0.13,
      incrementalCoefficient: 0.2,
      type: 'REGULAR_REVIEW'
    });
  }
  if (checkpointScreeningPhaseId) {
    reviewers.push({
      scorecardId: cfg.checkpointScreeningScorecardId || cfg.checkpointScorecardId,
      isMemberReview: true,
      memberReviewerCount: 1,
      phaseId: checkpointScreeningPhaseId,
      baseCoefficient: 0.13,
      incrementalCoefficient: 0.1,
      type: 'REGULAR_REVIEW'
    });
  }
  if (screeningPhaseId) {
    reviewers.push({
      scorecardId: cfg.screeningScorecardId || cfg.scorecardId,
      isMemberReview: true,
      memberReviewerCount: 1,
      phaseId: screeningPhaseId,
      baseCoefficient: 0.13,
      incrementalCoefficient: 0.1,
      type: 'REGULAR_REVIEW'
    });
  }
  if (approvalPhaseId) {
    reviewers.push({
      scorecardId: cfg.approvalScorecardId || cfg.scorecardId,
      isMemberReview: true,
      memberReviewerCount: 1,
      phaseId: approvalPhaseId,
      baseCoefficient: 0.13,
      incrementalCoefficient: 0.1,
      type: 'REGULAR_REVIEW'
    });
  }

  // Sanity check: ensure reviewer phaseIds correspond to phase TEMPLATE ids on the challenge
  await sanityCheckReviewerPhaseTemplates(log, token, challengeId, reviewers, cancel);

  const body = {
    typeId: cfg.challengeTypeId,
    trackId: cfg.challengeTrackId,
    name: `${cfg.challengeNamePrefix}${nanoid(6)}`,
    description: 'Design Challenge API Tester',
    tags: [], groups: [],
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
    reviewers,
    task: { isTask: false, isAssigned: false },
    skills: [{ name: 'Design', id: '63bb7cfc-b0d4-4584-820a-18c503b4b0fe' }],
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
  const updated = await TC.updateChallenge(token, challengeId, body);
  cancel.check();
  log.info('Challenge updated to DRAFT', { challengeId, request: body }, getStepProgress('updateDraft'));
  log.info('Configured review settings', {
    challengeId,
    reviewer: cfg.reviewer,
    checkpoints: Boolean(checkpointReviewPhaseId),
    screening: Boolean(screeningPhaseId),
    approval: Boolean(approvalPhaseId)
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
  cancel: CancellationHelpers
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
  cancel?: CancellationHelpers
) {
  log.info(`Waiting for phases to open/close: open=${mustOpen.join(', ')} close=${mustClose.join(', ')}`);
  let warned = false;
  while (true) {
    cancel?.check();
    try {
      const ch = await TC.getChallenge(token, challengeId);
      logChallengeSnapshot(log, progressStep, ch);
      const byName: Record<string, any> = {};
      for (const p of (ch.phases || [])) byName[p.name] = p;
      const openOk = mustOpen.every(n => byName[n]?.isOpen === true);
      const closeOk = mustClose.every(n => byName[n]?.isOpen === false);
      if (openOk && closeOk) { log.info('Phase state ok', { mustOpen, mustClose }, getStepProgress(progressStep)); return; }
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
      const msg = String(e?.message || e);
      if (!/504/.test(msg)) log.warn('Polling challenge failed; will retry', { error: msg });
    }
    await (cancel ? cancel.wait(10000) : new Promise(r => setTimeout(r, 10000)));
  }
}

async function stepAssignResources(
  log: RunnerLogger,
  token: string,
  cfg: DesignConfig,
  challengeId: string,
  cancel: CancellationHelpers
) {
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  cancel.check();
  log.info('Assigning resources (copilot, reviewers, screeners, approver, submitters)...');
  const lr = readLastRun();
  const reviewerResources = { ...(lr.reviewerResources || {}) } as Record<string, string>;
  const reviewerResourcesByHandle = ((lr as any).reviewerResourcesByHandle
    ? { ...(lr as any).reviewerResourcesByHandle }
    : {}) as Record<string, Record<string, string>>;

  const setResourceIds = (handle: string, roleName: string, resourceId: string | undefined) => {
    if (!handle || !resourceId) return;
    // Back-compat: preserve single mapping (may be overwritten if same handle holds many roles)
    reviewerResources[handle] = resourceId;
    // New: store per-role mapping to avoid collisions
    const bucket = reviewerResourcesByHandle[handle] || {};
    bucket[roleName] = resourceId;
    // Allow looking up either Screener/Primary Screener regardless of fallback role choice
    if (roleName === 'Primary Screener') bucket.Screener = resourceId;
    if (roleName === 'Screener') bucket['Primary Screener'] = resourceId;
    reviewerResourcesByHandle[handle] = bucket;
  };

  log.info('REQ listResourceRoles');
  const roles = await TC.listResourceRoles(token);
  cancel.check();
  const roleIdByName: Record<string, string> = {};
  for (const role of Array.isArray(roles) ? roles : []) {
    if (role?.name && role?.id) roleIdByName[role.name] = role.id;
  }
  const submitterRoleId = roleIdByName['Submitter'];
  const reviewerRoleId = roleIdByName['Reviewer'];
  const screenerRoleId = roleIdByName['Screener'];
  const primaryScreenerRoleId = roleIdByName['Primary Screener'];
  const approverRoleId = roleIdByName['Approver'];
  const checkpointScreenerRoleId = roleIdByName['Checkpoint Screener'];
  const checkpointReviewerRoleId = roleIdByName['Checkpoint Reviewer'];
  const copilotRoleId = roleIdByName['Copilot'];
  if (!submitterRoleId) log.warn('Submitter role not found; submissions may fail');
  if (!reviewerRoleId) log.warn('Reviewer role not found; review assignment may fail');
  if (!screenerRoleId && !primaryScreenerRoleId) {
    log.warn('Screener role not found; screening assignment may fail');
  } else if (!screenerRoleId) {
    log.warn('Screener role not found; falling back to Primary Screener');
  }
  if (!approverRoleId) log.warn('Approver role not found; approval assignment may fail');
  if (!checkpointScreenerRoleId) log.warn('Checkpoint Screener role not found; checkpoint screening may fail');
  if (!checkpointReviewerRoleId) log.warn('Checkpoint Reviewer role not found; checkpoint review assignment may fail');

  if (cfg.copilotHandle && copilotRoleId) {
    cancel.check();
    const mem = await TC.getMemberByHandle(token, cfg.copilotHandle);
    cancel.check();
    const payload = { challengeId, memberId: String(mem.userId), roleId: copilotRoleId };
    log.info('REQ addResource', payload);
    await TC.addResource(token, payload);
    cancel.check();
    log.info('RES addResource', { ok: true, role: 'Copilot' });
  }

  // Reviewer (single)
  if (cfg.reviewer && reviewerRoleId) {
    cancel.check();
    const mem = await TC.getMemberByHandle(token, cfg.reviewer);
    cancel.check();
    const payload = { challengeId, memberId: String(mem.userId), roleId: reviewerRoleId };
    log.info('REQ addResource', payload);
    const added = await TC.addResource(token, payload);
    cancel.check();
    const resourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : undefined;
    setResourceIds(cfg.reviewer, 'Reviewer', resourceId);
    log.info('RES addResource', { ok: true, role: 'Reviewer', resourceId });
  }

  // Screener (prefers Screener role, falls back to Primary Screener)
  const screenerHandle = cfg.screener || cfg.screeningReviewer || cfg.reviewer;
  const screenerRoleToUse = screenerRoleId || primaryScreenerRoleId;
  if (screenerHandle && screenerRoleToUse) {
    const roleLabel = screenerRoleId ? 'Screener' : 'Primary Screener';
    try {
      cancel.check();
      const mem = await TC.getMemberByHandle(token, screenerHandle);
      cancel.check();
      const payload = { challengeId, memberId: String(mem.userId), roleId: screenerRoleToUse };
      log.info('REQ addResource', payload);
      const added = await TC.addResource(token, payload);
      cancel.check();
      const resourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : undefined;
      setResourceIds(screenerHandle, roleLabel, resourceId);
      log.info('RES addResource', { ok: true, role: roleLabel, resourceId });
    } catch (error: any) {
      log.warn('Failed to add screener resource (may already exist)', { handle: screenerHandle, error: error?.message || String(error) });
    }
  } else if (screenerHandle) {
    log.warn('Screener handle configured but no Screener role is available', { handle: screenerHandle });
  }

  // Approver
  const approverHandle = cfg.approver || cfg.reviewer;
  if (approverHandle && approverRoleId) {
    try {
      cancel.check();
      const mem = await TC.getMemberByHandle(token, approverHandle);
      cancel.check();
      const payload = { challengeId, memberId: String(mem.userId), roleId: approverRoleId };
      log.info('REQ addResource', payload);
      const added = await TC.addResource(token, payload);
      cancel.check();
      const resourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : undefined;
      if (resourceId) reviewerResources[approverHandle] = resourceId;
      log.info('RES addResource', { ok: true, role: 'Approver', resourceId });
    } catch (error: any) {
      log.warn('Failed to add approver resource (may already exist)', { handle: approverHandle, error: error?.message || String(error) });
    }
  }

  // Checkpoint Screener
  const ckptScreenerHandle = cfg.checkpointScreener || cfg.screener || cfg.screeningReviewer || cfg.reviewer;
  if (ckptScreenerHandle && checkpointScreenerRoleId) {
    try {
      cancel.check();
      const mem = await TC.getMemberByHandle(token, ckptScreenerHandle);
      cancel.check();
      const payload = { challengeId, memberId: String(mem.userId), roleId: checkpointScreenerRoleId };
      log.info('REQ addResource', payload);
      const added = await TC.addResource(token, payload);
      cancel.check();
      const resourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : undefined;
      setResourceIds(ckptScreenerHandle, 'Checkpoint Screener', resourceId);
      log.info('RES addResource', { ok: true, role: 'Checkpoint Screener', resourceId });
    } catch (error: any) {
      log.warn('Failed to add checkpoint screener resource (may already exist)', { handle: ckptScreenerHandle, error: error?.message || String(error) });
    }
  }

  // Checkpoint Reviewer
  const ckptReviewerHandle = cfg.checkpointReviewer || cfg.reviewer;
  if (ckptReviewerHandle && checkpointReviewerRoleId) {
    try {
      cancel.check();
      const mem = await TC.getMemberByHandle(token, ckptReviewerHandle);
      cancel.check();
      const payload = { challengeId, memberId: String(mem.userId), roleId: checkpointReviewerRoleId };
      log.info('REQ addResource', payload);
      const added = await TC.addResource(token, payload);
      cancel.check();
      const resourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : undefined;
      setResourceIds(ckptReviewerHandle, 'Checkpoint Reviewer', resourceId);
      log.info('RES addResource', { ok: true, role: 'Checkpoint Reviewer', resourceId });
    } catch (error: any) {
      log.warn('Failed to add checkpoint reviewer resource (may already exist)', { handle: ckptReviewerHandle, error: error?.message || String(error) });
    }
  }

  // Submitters
  for (const handle of cfg.submitters) {
    if (!submitterRoleId) continue;
    cancel.check();
    const mem = await TC.getMemberByHandle(token, handle);
    cancel.check();
    const payload = { challengeId, memberId: String(mem.userId), roleId: submitterRoleId };
    log.info('REQ addResource', payload);
    try {
      await TC.addResource(token, payload);
      cancel.check();
      log.info('RES addResource', { ok: true, role: 'Submitter', handle });
    } catch (error: any) {
      log.warn('Failed to add submitter resource (may already exist)', { handle, error: error?.message || String(error) });
    }
  }

  writeLastRun({ reviewerResources, reviewerResourcesByHandle });
  log.info('Resources assigned', {
    reviewer: cfg.reviewer,
    screener: cfg.screener || cfg.screeningReviewer,
    approver: cfg.approver,
    checkpointScreener: cfg.checkpointScreener,
    checkpointReviewer: cfg.checkpointReviewer,
    submitters: cfg.submitters.length
  }, getStepProgress('assignResources'));
}

async function stepCreateSubmissionsInternal(
  log: RunnerLogger,
  token: string,
  cfg: DesignConfig,
  challengeId: string,
  submissionType: 'CONTEST_SUBMISSION' | 'CHECKPOINT_SUBMISSION',
  progressStep: StepName,
  cancel: CancellationHelpers
) {
  const { writeLastRun, readLastRun } = await import('../utils/lastRun.js');

  log.info('Preparing submission artifact from disk', { configuredPath: cfg.submissionZipPath });
  const artifact = await loadSubmissionArtifact(cfg.submissionZipPath);
  cancel.check();
  log.info('Submission artifact ready', { path: artifact.absolutePath, size: artifact.size });

  const lr = readLastRun();
  const mapKey = submissionType === 'CHECKPOINT_SUBMISSION' ? 'checkpointSubmissions' : 'submissions';
  const currentMap: Record<string, string[]> = (lr as any)[mapKey] || {};
  let createdCount = 0;
  for (const handle of cfg.submitters) {
    cancel.check();
    const mem = await TC.getMemberByHandle(token, handle);
    cancel.check();
    const perSubmitter = cfg.submissionsPerSubmitter || 1;
    for (let i = 0; i < perSubmitter; i++) {
      cancel.check();
      const upload = await uploadSubmissionArtifact(log, artifact);
      cancel.check();
      const payload = { challengeId, memberId: String(mem.userId), type: submissionType, url: upload.url };
      log.info('REQ createSubmission', { ...payload, storageKey: upload.key });
      const sub = await TC.createSubmission(token, payload);
      cancel.check();
      log.info('RES createSubmission', { id: sub.id, handle, storageKey: upload.key });
      currentMap[handle] = currentMap[handle] || [];
      currentMap[handle].push(String(sub.id));
      writeLastRun({ [mapKey]: currentMap } as any);
      createdCount += 1;
    }
  }

  log.info(`${submissionType === 'CHECKPOINT_SUBMISSION' ? 'Checkpoint' : 'Final'} submissions created`, { count: createdCount }, getStepProgress(progressStep));
}

function randPick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function buildMarkdownReviewItemComment(question: any, answerLabel: string, extraLines: string[] = []): string {
  const rawDescription = typeof question?.description === 'string' ? question.description.trim() : '';
  const description = rawDescription || `Question ${question?.id ?? ''}`.trim() || 'Review item';
  const lines = [
    '### Automated Review Summary',
    '',
    `**Question:** ${description}`,
    `**Recorded Answer:** ${answerLabel}`
  ];
  if (extraLines.length) lines.push('', ...extraLines);
  lines.push('', '```bash', 'npm run verify', '```');
  return lines.join('\n');
}

async function stepPatchPendingReviews(
  log: RunnerLogger,
  token: string,
  cfg: DesignConfig,
  challengeId: string,
  progressStep: StepName,
  scorecardIdForQuestions: string,
  reviewerHandle: string,
  submissionMapKey: 'submissions' | 'checkpointSubmissions',
  phaseNameHints: string[] = [],
  cancel: CancellationHelpers
) {
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  const roleNameForStep = (step: StepName): string | undefined => {
    switch (step) {
      case 'createCheckpointScreeningReviews': return 'Checkpoint Screener';
      case 'createCheckpointReviews': return 'Checkpoint Reviewer';
      case 'createScreeningReviews': return 'Screener';
      case 'createReviews': return 'Reviewer';
      default: return undefined;
    }
  };
  log.info('Loading target scorecard for questions', { scorecardId: scorecardIdForQuestions });
  const scorecard = await TC.getScorecard(token, scorecardIdForQuestions);
  cancel.check();
  const groups = scorecard?.scorecardGroups || [];
  const questions: any[] = [];
  for (const g of groups) for (const s of (g.sections || [])) for (const q of (s.questions || [])) questions.push(q);
  // Load run snapshot and prepare reviewer resource IDs + expected submissions
  const lr = readLastRun();
  const byHandle = (lr as any).reviewerResourcesByHandle as Record<string, Record<string, string>> | undefined;
  const roleHint = roleNameForStep(progressStep);
  const candidateResourceIds: string[] = [];
  if (byHandle?.[reviewerHandle]) {
    if (roleHint && byHandle[reviewerHandle][roleHint]) candidateResourceIds.push(byHandle[reviewerHandle][roleHint]);
    for (const v of Object.values(byHandle[reviewerHandle])) if (v && !candidateResourceIds.includes(v)) candidateResourceIds.push(v);
  }
  const legacyId = (lr.reviewerResources && lr.reviewerResources[reviewerHandle]) || undefined;
  if (legacyId && !candidateResourceIds.includes(legacyId)) candidateResourceIds.push(legacyId);

  const submissionsMap: Record<string, string[]> = (lr as any)[submissionMapKey] || {};
  const handles = Object.keys(submissionsMap);
  const expectedCount = handles.reduce((acc, h) => acc + ((submissionsMap[h] || []).length), 0);
  const ensureCheckpointFailure = progressStep === 'createCheckpointScreeningReviews';
  const checkpointFailureSet = new Set<string>();
  if (ensureCheckpointFailure) {
    for (const handle of handles) {
      const perHandle = submissionsMap[handle] || [];
      if (perHandle.length) {
        // Intentionally fail the first submission for each handle.
        checkpointFailureSet.add(String(perHandle[0]));
      }
    }
  }

  const phaseHints = Array.isArray(phaseNameHints) ? phaseNameHints : [];
  let fallbackReviewTypeId: string | undefined;
  let fallbackReviewTypeIdResolved = phaseHints.length === 0;
  let defaultFallbackWarned = false;
  const ensureFallbackReviewTypeId = async () => {
    if (fallbackReviewTypeIdResolved) return fallbackReviewTypeId;
    fallbackReviewTypeId = await resolveReviewTypeIdForPhase(log, token, cancel, phaseHints);
    fallbackReviewTypeIdResolved = true;
    return fallbackReviewTypeId;
  };

  // Poll briefly for Autopilot to create pending reviews if they haven't appeared yet
  let pendingByKey = new Map<string, any>();
  let pendingBySubmission = new Map<string, any[]>();
  const maxAttempts = 12; // ~60s total with 5s waits
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    cancel.check();
    log.info('REQ listReviews', { challengeId });
    const listResponse = await TC.listReviews(token, challengeId);
    cancel.check();
    const existingReviews = Array.isArray(listResponse) ? listResponse : Array.isArray((listResponse as any)?.data) ? (listResponse as any).data : [];
    pendingByKey = new Map<string, any>();
    pendingBySubmission = new Map<string, any[]>();
    for (const review of existingReviews) {
      const status = typeof review?.status === 'string' ? review.status.toUpperCase() : '';
      if (status !== 'PENDING' && status !== 'IN_PROGRESS') continue;
      const resourceId = toStringId((review as any).resourceId);
      const submissionId = toStringId((review as any).submissionId);
      if (resourceId && submissionId) pendingByKey.set(`${resourceId}:${submissionId}`, review);
      if (submissionId) {
        const bucket = pendingBySubmission.get(submissionId) || [];
        bucket.push(review);
        pendingBySubmission.set(submissionId, bucket);
      }
    }
    log.info('Pending reviews discovered', { count: pendingByKey.size, attempt: attempt + 1 });

    // Determine if we have enough pending reviews to proceed (either matched by resource or unique per submission)
    let readyMatches = 0;
    for (const handle of handles) {
      for (const subId of submissionsMap[handle]) {
        let matched = false;
        for (const rid of candidateResourceIds) {
          if (pendingByKey.has(`${rid}:${subId}`)) { matched = true; break; }
        }
        if (!matched) {
          const bucket = pendingBySubmission.get(String(subId)) || [];
          if (bucket.length === 1) matched = true;
        }
        if (matched) readyMatches += 1;
      }
    }
    if (readyMatches >= expectedCount) break;
    if (attempt < maxAttempts - 1) await cancel.wait(5000);
  }
  const patched: any[] = [];
  for (const handle of handles) {
    for (const subId of submissionsMap[handle]) {
      cancel.check();
      // Try exact match by known resource IDs first
      let pending: any | undefined;
      for (const rid of candidateResourceIds) {
        const key = `${rid}:${subId}`;
        if (pendingByKey.has(key)) { pending = pendingByKey.get(key); break; }
      }
      // Fallback: if no resource matched, and there is exactly one pending review for this submission, use it
      if (!pending) {
        const bucket = pendingBySubmission.get(String(subId)) || [];
        if (bucket.length === 1) pending = bucket[0];
      }
      if (!pending) continue;
      const shouldFail = ensureCheckpointFailure && checkpointFailureSet.has(String(subId));
      const outcomeLabel = shouldFail ? 'fail' : 'pass';
      const scoreForOutcome = shouldFail ? 10 : 100;
      const existingItems = Array.isArray(pending.reviewItems) ? pending.reviewItems : [];
      const itemsByQuestion = new Map<string, any>(existingItems
        .filter((item: any) => item && item.scorecardQuestionId !== undefined)
        .map((item: any) => [String(item.scorecardQuestionId), item])
      );
      const reviewItems = questions.map(q => {
        if (q.type === 'YES_NO') {
          const existingItem = itemsByQuestion.get(String(q.id));
          const answer = ensureCheckpointFailure
            ? (shouldFail ? 'NO' : 'YES')
            : randPick(['YES', 'NO']);
          const payload: any = {
            scorecardQuestionId: q.id,
            initialAnswer: answer,
            reviewItemComments: [{ content: buildMarkdownReviewItemComment(q, answer), type: 'COMMENT', sortOrder: 1 }]
          };
          if (existingItem?.id !== undefined) payload.id = existingItem.id;
          return payload;
        } else if (q.type === 'SCALE') {
          const existingItem = itemsByQuestion.get(String(q.id));
          const min = typeof q.scaleMin === 'number' ? q.scaleMin : 1;
          const max = typeof q.scaleMax === 'number' ? q.scaleMax : 10;
          const value = ensureCheckpointFailure
            ? String(shouldFail ? min : max)
            : String(randInt(min, max));
          const payload: any = {
            scorecardQuestionId: q.id,
            initialAnswer: value,
            reviewItemComments: [{ content: buildMarkdownReviewItemComment(q, value), type: 'COMMENT', sortOrder: 1 }]
          };
          if (existingItem?.id !== undefined) payload.id = existingItem.id;
          return payload;
        } else {
          const existingItem = itemsByQuestion.get(String(q.id));
          const answer = ensureCheckpointFailure
            ? (shouldFail ? 'NO' : 'YES')
            : 'YES';
          const payload: any = {
            scorecardQuestionId: q.id,
            initialAnswer: answer,
            reviewItemComments: [{ content: buildMarkdownReviewItemComment(q, answer), type: 'COMMENT', sortOrder: 1 }]
          };
          if (existingItem?.id !== undefined) payload.id = existingItem.id;
          return payload;
        }
      });
      const rawMetadata = pending?.metadata;
      const metadata = ensureCheckpointFailure
        ? {
            ...(typeof rawMetadata === 'object' && rawMetadata !== null ? { ...(rawMetadata as any) } : {}),
            outcome: outcomeLabel,
            score: scoreForOutcome
          }
        : (rawMetadata || {});

      const payload = {
        scorecardId: pending?.scorecardId || scorecardIdForQuestions,
        typeId: (() => {
          const existing = toStringId((pending as any)?.typeId);
          return existing ?? '';
        })(),
        metadata,
        status: 'COMPLETED',
        reviewDate: dayjs().toISOString(),
        committed: true,
        reviewItems
      };
      if (ensureCheckpointFailure) {
        (payload as any).score = scoreForOutcome;
        (payload as any).isPassing = !shouldFail;
      }
      if (!payload.typeId) {
        const resolvedTypeId = await ensureFallbackReviewTypeId();
        if (resolvedTypeId) {
          payload.typeId = resolvedTypeId;
        } else {
          payload.typeId = 'REVIEW';
          if (!defaultFallbackWarned && phaseHints.length) {
            const reviewId = toStringId((pending as any)?.id);
            log.warn('Falling back to default review type ID for review', {
              reviewId,
              phaseHints
            });
            defaultFallbackWarned = true;
          }
        }
      }
      try {
        log.info('REQ patchReview', { reviewId: String(pending.id), payload });
        const r = await TC.updateReview(token, String(pending.id), payload);
        cancel.check();
        patched.push(r);
        const key2 = `${reviewerHandle}:${handle}:${subId}`;
        const reviews = { ...(lr.reviews || {}), [key2]: r.id };
        writeLastRun({ reviews });
        log.info('Patched review', { reviewId: r.id, handle, submissionId: subId });
      } catch (e: any) {
        log.warn('Patch review failed', { error: e?.message || String(e) });
      }
    }
  }

  log.info('Reviews patched', { count: patched.length }, getStepProgress(progressStep));
}

async function stepApprovalFlow(
  log: RunnerLogger,
  token: string,
  cfg: DesignConfig,
  challengeId: string,
  cancel: CancellationHelpers
) {
  // First attempt: fail approval to exercise iterative behavior
  await patchAnyPendingApproval(log, token, cfg, challengeId, false, cancel);
  // Wait for approval phase to close and reopen
  await ensureApprovalPhaseState(log, token, challengeId, false, cancel, 'createApprovalReview');
  await ensureApprovalPhaseState(log, token, challengeId, true, cancel, 'createApprovalReview');
  // Second attempt: pass approval
  await patchAnyPendingApproval(log, token, cfg, challengeId, true, cancel);
}

async function patchAnyPendingApproval(
  log: RunnerLogger,
  token: string,
  cfg: DesignConfig,
  challengeId: string,
  pass: boolean,
  cancel: CancellationHelpers
) {
  log.info(`Searching for pending Approval review to mark as ${pass ? 'pass' : 'fail'}...`);
  const listResponse = await TC.listReviews(token, challengeId);
  cancel.check();
  const list = Array.isArray(listResponse) ? listResponse : Array.isArray((listResponse as any)?.data) ? (listResponse as any).data : [];
  const pending = list.filter((r: any) => {
    const status = typeof r?.status === 'string' ? r.status.toUpperCase() : '';
    return status === 'PENDING' || status === 'IN_PROGRESS';
  });
  if (!pending.length) {
    log.warn('No pending approval reviews found');
    return;
  }
  const target = pending[0];
  const scorecardId = target?.scorecardId || cfg.approvalScorecardId || cfg.scorecardId;
  const scorecard = await TC.getScorecard(token, String(scorecardId));
  cancel.check();
  const groups = scorecard?.scorecardGroups || [];
  const questions: any[] = [];
  for (const g of groups) for (const s of (g.sections || [])) for (const q of (s.questions || [])) questions.push(q);
  const reviewItems = questions.map(q => {
    if (q.type === 'YES_NO') {
      const answer = pass ? 'YES' : 'NO';
      return { scorecardQuestionId: q.id, initialAnswer: answer, reviewItemComments: [{ content: buildMarkdownReviewItemComment(q, answer), type: 'COMMENT', sortOrder: 1 }] };
    } else if (q.type === 'SCALE') {
      const value = pass ? String(q.scaleMax ?? 10) : String(q.scaleMin ?? 1);
      return { scorecardQuestionId: q.id, initialAnswer: value, reviewItemComments: [{ content: buildMarkdownReviewItemComment(q, value), type: 'COMMENT', sortOrder: 1 }] };
    }
    return { scorecardQuestionId: q.id, initialAnswer: pass ? 'YES' : 'NO', reviewItemComments: [{ content: buildMarkdownReviewItemComment(q, pass ? 'YES' : 'NO'), type: 'COMMENT', sortOrder: 1 }] };
  });

  const existingTypeId = toStringId((target as any)?.typeId);
  let approvalTypeId = existingTypeId;
  if (!approvalTypeId) {
    const resolved = await resolveReviewTypeIdForPhase(log, token, cancel, ['Approval']);
    if (resolved) {
      approvalTypeId = resolved;
    } else {
      approvalTypeId = 'REVIEW';
      const reviewId = toStringId((target as any)?.id);
      log.warn('Falling back to default review type ID for approval review', {
        reviewId,
        phaseHints: ['Approval']
      });
    }
  }

  const payload = {
    scorecardId: scorecardId,
    typeId: approvalTypeId,
    metadata: target?.metadata || {},
    status: 'COMPLETED',
    reviewDate: dayjs().toISOString(),
    committed: true,
    reviewItems
  };
  try {
    log.info('REQ patchReview', { reviewId: String(target.id), payload });
    await TC.updateReview(token, String(target.id), payload);
    cancel.check();
    log.info('Approval review completed', { reviewId: String(target.id), result: pass ? 'pass' : 'fail' }, getStepProgress('createApprovalReview'));
  } catch (e: any) {
    log.warn('Failed to complete approval review', { error: e?.message || String(e) });
  }
}

async function ensureApprovalPhaseState(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  expectOpen: boolean,
  cancel: CancellationHelpers,
  step: StepName
) {
  const mustOpen = expectOpen ? ['Approval'] : [];
  const mustClose = expectOpen ? [] : ['Approval'];
  log.info(`Waiting for Approval phase to ${expectOpen ? 'open' : 'close'}...`);
  while (true) {
    cancel.check();
    try {
      const ch = await TC.getChallenge(token, challengeId);
      logChallengeSnapshot(log, step, ch);
      const byName: Record<string, any> = {};
      for (const p of (ch.phases || [])) byName[p.name] = p;
      const openOk = mustOpen.every(n => byName[n]?.isOpen === true);
      const closeOk = mustClose.every(n => byName[n]?.isOpen === false);
      if (openOk && closeOk) return;
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (!/504/.test(msg)) log.warn('Polling challenge failed; will retry', { error: msg });
    }
    await cancel.wait(5000);
  }
}

async function stepAwaitAllClosed(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers
) {
  log.info('Waiting for all phases to be closed...');
  while (true) {
    cancel.check();
    const ch = await TC.getChallenge(token, challengeId);
    logChallengeSnapshot(log, 'awaitAllClosed', ch);
    const allClosed = (ch.phases || []).every((p:any) => p.isOpen === false);
    if (allClosed) { log.info('All phases are closed', undefined, getStepProgress('awaitAllClosed')); return; }
    await cancel.wait(10000);
  }
}

async function stepAwaitCompletion(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers
) {
  log.info('Waiting for challenge to reach COMPLETED and winners set...');
  while (true) {
    cancel.check();
    const ch = await TC.getChallenge(token, challengeId);
    logChallengeSnapshot(log, 'awaitCompletion', ch);
    if (ch.status === 'COMPLETED' && Array.isArray(ch.winners) && ch.winners.length > 0) {
      log.info('Challenge completed with winners', { winners: ch.winners }, getStepProgress('awaitCompletion'));
      return;
    }
    await cancel.wait(10000);
  }
}
