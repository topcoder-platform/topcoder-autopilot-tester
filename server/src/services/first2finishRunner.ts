import dayjs from 'dayjs';
import { nanoid } from 'nanoid';
import { RunnerLogger, type StepRequestLog, type StepStatus } from '../utils/logger.js';
import { setActiveStepRequestRecorder, type StepRequestLogInput } from '../utils/stepRequestRecorder.js';
import { getToken, TC } from './topcoder.js';
import { loadSubmissionArtifact, uploadSubmissionArtifact } from './submissionUploader.js';
import type { First2FinishConfig } from '../types/config.js';

export type RunMode = 'full' | 'toStep';
export type StepName =
  | 'token'
  | 'createChallenge'
  | 'updateDraft'
  | 'activate'
  | 'awaitRegSubOpen'
  | 'assignResources'
  | 'awaitSubmissionEnd'
  | 'loadInitialSubmissions'
  | 'processReviews'
  | 'finalSubmission'
  | 'postMortem'
  | 'awaitWinner';

const STEPS: StepName[] = [
  'token',
  'createChallenge',
  'updateDraft',
  'activate',
  'awaitRegSubOpen',
  'assignResources',
  'awaitSubmissionEnd',
  'loadInitialSubmissions',
  'processReviews',
  'finalSubmission',
  'postMortem',
  'awaitWinner'
];

const PROGRESS_STEPS: StepName[] = STEPS.filter(step => step !== 'token');

const INITIAL_SUBMISSIONS_PER_SUBMITTER = 2;
const INITIAL_SUBMISSION_DELAY_MS = 10_000;

const ITERATIVE_REVIEW_PHASE_ID = '003a4b14-de5d-43fc-9e35-835dbeb6af1f';

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

function logChallengeSnapshot(log: RunnerLogger, stage: StepName, challenge: any) {
  log.info('Challenge refresh', { stage, challenge });
}

function toStringId(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && !Number.isNaN(value)) return String(value);
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

function maybeStop(mode: RunMode, toStep: StepName | undefined, current: StepName, log: RunnerLogger) {
  if (mode === 'toStep' && toStep === current) {
    log.info(`Stopping at step '${current}' as requested`, { step: current }, 100);
    throw new Error('__STOP_EARLY__');
  }
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
  cfg: First2FinishConfig,
  cancel: CancellationHelpers
) {
  cancel.check();
  log.info('Creating First2Finish challenge...');
  const challengeName = `${cfg.challengeNamePrefix}${nanoid(8)}`;
  const payload = {
    name: challengeName,
    typeId: cfg.challengeTypeId,
    trackId: cfg.challengeTrackId,
    timelineTemplateId: cfg.timelineTemplateId,
    projectId: cfg.projectId,
    status: 'NEW',
    description: 'First2Finish end-to-end test',
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
  cfg: First2FinishConfig,
  challengeId: string,
  cancel: CancellationHelpers,
  submissionPhaseName: string
) {
  cancel.check();
  log.info('Updating challenge to DRAFT with condensed timeline...');
  const nowIso = dayjs().toISOString();
  const body = {
    typeId: cfg.challengeTypeId,
    trackId: cfg.challengeTrackId,
    name: `${cfg.challengeNamePrefix}${nanoid(6)}`,
    description: 'First2Finish autopilot test',
    tags: [],
    groups: [],
    metadata: [],
    startDate: nowIso,
    prizeSets: [
      {
        type: 'PLACEMENT',
        prizes: [{ type: 'USD', value: cfg.prize }]
      },
      { type: 'COPILOT', prizes: [{ type: 'USD', value: 100 }] }
    ],
    winners: [],
    reviewers: [
      {
        scorecardId: cfg.scorecardId,
        isMemberReview: true,
        memberReviewerCount: 1,
        phaseId: ITERATIVE_REVIEW_PHASE_ID,
        basePayment: 10,
        incrementalPayment: 10,
        type: 'ITERATIVE_REVIEW'
      }
    ],
    discussions: [],
    task: { isTask: false, isAssigned: false },
    skills: [{ name: 'Java', id: '63bb7cfc-b0d4-4584-820a-18c503b4b0fe' }],
    legacy: {
      reviewType: 'COMMUNITY',
      confidentialityType: 'public',
      directProjectId: cfg.projectId,
      isTask: false,
      useSchedulingAPI: false,
      pureV5Task: false,
      pureV5: false,
      selfService: false
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
  const normalizedSubmissionPhase = submissionPhaseName.trim().toLowerCase();
  if (normalizedSubmissionPhase === 'topgear submission') {
    await ensureConcurrentRegistrationAndSubmission(log, token, challengeId, submissionPhaseName, cancel);
    cancel.check();
  }
  log.info('Challenge updated to DRAFT', { challengeId, request: body }, getStepProgress('updateDraft'));
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

function sanitizePhasePatchPayload(phase: any) {
  const allowedKeys = [
    'id',
    'phaseId',
    'duration',
    'name',
    'predecessor',
    'predecessorId',
    'scheduledStartDate',
    'scheduledEndDate',
    'fixedStartDate',
    'actualStartDate',
    'actualEndDate'
  ];
  const payload: Record<string, any> = {};
  for (const key of allowedKeys) {
    if (phase?.[key] !== undefined) {
      payload[key] = phase[key];
    }
  }
  if (phase?.predecessors !== undefined) {
    payload.predecessors = Array.isArray(phase.predecessors) ? [...phase.predecessors] : phase.predecessors;
  }
  if (typeof payload.duration === 'string') {
    const parsed = Number(payload.duration);
    if (!Number.isNaN(parsed)) payload.duration = parsed;
  }
  return payload;
}

function collectPhaseIdentifiers(phase: any): string[] {
  return [
    toStringId(phase?.id),
    toStringId(phase?.phaseId),
    toStringId(phase?.phase_id),
    toStringId(phase?.legacyId)
  ].filter(Boolean) as string[];
}

function collectPredecessorIdentifiers(phase: any): string[] {
  const ids = new Set<string>();
  if (!phase) return [];
  const add = (value: any) => {
    const id = toStringId(value);
    if (id) ids.add(id);
  };
  add(phase?.predecessor);
  add((phase as any)?.predecessorId);
  add((phase as any)?.predecessor_id);
  const predecessor = (phase as any)?.predecessor;
  if (predecessor && typeof predecessor === 'object') {
    add(predecessor.id);
    add(predecessor.phaseId);
    add(predecessor.phase_id);
  }
  const predecessors = (phase as any)?.predecessors;
  if (Array.isArray(predecessors)) {
    for (const entry of predecessors) {
      add(entry);
      if (entry && typeof entry === 'object') {
        add(entry.id);
        add(entry.phaseId);
        add(entry.phase_id);
      }
    }
  }
  return [...ids];
}

async function ensureConcurrentRegistrationAndSubmission(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  submissionPhaseName: string,
  cancel: CancellationHelpers
) {
  cancel.check();
  log.info('Ensuring Topgear submission phase does not depend on Registration', {
    challengeId,
    submissionPhaseName
  });
  const challenge = await TC.getChallenge(token, challengeId);
  cancel.check();
  const phases = Array.isArray(challenge?.phases) ? challenge.phases : [];
  if (!phases.length) {
    log.warn('Challenge returned no phases when attempting to adjust submission predecessor', {
      challengeId
    });
    return;
  }

  const findByName = (name: string) => {
    const normalized = name.trim().toLowerCase();
    return phases.find((phase: any) => typeof phase?.name === 'string' && phase.name.trim().toLowerCase() === normalized);
  };

  const registrationPhase = findByName('Registration');
  const submissionPhase = findByName(submissionPhaseName);

  if (!submissionPhase) {
    log.warn('Submission phase not found while attempting to adjust predecessor', {
      challengeId,
      submissionPhaseName
    });
    return;
  }

  const registrationIds = new Set<string>(collectPhaseIdentifiers(registrationPhase));
  const submissionPredecessors = collectPredecessorIdentifiers(submissionPhase);
  const hasRegistrationDependency = submissionPredecessors.some((id) => registrationIds.has(id));

  const registrationStart =
    registrationPhase?.scheduledStartDate ||
    registrationPhase?.actualStartDate ||
    registrationPhase?.fixedStartDate;

  const phasePatch = sanitizePhasePatchPayload(submissionPhase);
  let mutated = false;

  if (hasRegistrationDependency) {
    phasePatch.predecessor = null;
    phasePatch.predecessorId = null;
    phasePatch.predecessors = [];
    mutated = true;
  }

  if (registrationStart && phasePatch.scheduledStartDate !== registrationStart) {
    phasePatch.scheduledStartDate = registrationStart;
    if (typeof phasePatch.duration === 'number' && !Number.isNaN(phasePatch.duration)) {
      phasePatch.scheduledEndDate = dayjs(registrationStart).add(phasePatch.duration, 'second').toISOString();
    }
    mutated = true;
  }

  if (!mutated) {
    log.info('Topgear submission phase already concurrent with Registration', {
      challengeId,
      submissionPhaseName
    });
    return;
  }

  cancel.check();
  await TC.patchChallenge(token, challengeId, { phases: [phasePatch] });
  cancel.check();

  log.info('Updated Topgear submission phase to remove Registration predecessor', {
    challengeId,
    submissionPhaseId: toStringId(phasePatch.id) || toStringId(phasePatch.phaseId),
    submissionPhaseName,
    removedDependency: hasRegistrationDependency,
    alignedStartWithRegistration: Boolean(registrationStart)
  });
}

async function stepActivate(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers
) {
  cancel.check();
  log.info('Activating challenge...');
  await TC.activateChallenge(token, challengeId);
  cancel.check();
  log.info('Challenge set ACTIVE', { challengeId, request: { status: 'ACTIVE' } }, getStepProgress('activate'));
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
      if (openOk && closeOk) {
        log.info('Phase state ok', { mustOpen, mustClose }, getStepProgress(progressStep));
        return;
      }
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
    } catch (error: any) {
      const msg = String(error?.message || error);
      if (!/504/.test(msg)) log.warn('Polling challenge failed; will retry', { error: msg });
    }
    await (cancel ? cancel.wait(5000) : new Promise(r => setTimeout(r, 5000)));
  }
}

async function stepAwaitSubmissionScheduledEnd(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers,
  submissionPhaseName: string
) {
  log.info(`Waiting until ${submissionPhaseName} scheduled end is reached...`);
  let announced = false;
  while (true) {
    cancel.check();
    try {
      const ch = await TC.getChallenge(token, challengeId);
      logChallengeSnapshot(log, 'awaitSubmissionEnd', ch);
      const phases = Array.isArray(ch?.phases) ? ch.phases : [];
      const submissionPhase = phases.find((p: any) => p?.name === submissionPhaseName);
      const end = submissionPhase?.scheduledEndDate ? new Date(submissionPhase.scheduledEndDate).getTime() : null;
      const isOpen = submissionPhase?.isOpen === true;
      if (end) {
        const now = Date.now();
        if (now >= end + 1000) {
          log.info(`${submissionPhaseName} scheduled end reached`, { isOpen }, getStepProgress('awaitSubmissionEnd'));
          return;
        }
        const waitMs = Math.min(end - now + 1000, 15_000);
        if (!announced) {
          log.info('Waiting for scheduled end of submission phase', { ms: waitMs });
          announced = true;
        }
        await cancel.wait(Math.max(1000, waitMs));
        continue;
      }
    } catch (e: any) {
      log.warn('Failed to refresh challenge while waiting for scheduled end; will retry', { error: e?.message || String(e) });
    }
    await cancel.wait(5000);
  }
}

type ReviewerAssignment = {
  resourceId: string;
  handle: string;
};

async function stepAssignResources(
  log: RunnerLogger,
  token: string,
  cfg: First2FinishConfig,
  challengeId: string,
  cancel: CancellationHelpers
): Promise<ReviewerAssignment> {
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  cancel.check();
  log.info('Assigning resources (copilot, iterative reviewer, submitters)...');
  const lr = readLastRun();
  const reviewerResources = { ...(lr.reviewerResources || {}) } as Record<string, string>;

  const roles = await TC.listResourceRoles(token);
  cancel.check();
  const roleIdByName: Record<string, string> = {};
  for (const role of Array.isArray(roles) ? roles : []) {
    if (role?.name && role?.id) {
      roleIdByName[role.name] = role.id;
    }
  }
  const submitterRole = roleIdByName['Submitter'];
  const iterativeReviewerRole = roleIdByName['Iterative Reviewer'];
  const copilotRole = roleIdByName['Copilot'];
  if (!submitterRole) log.warn('Submitter role not found; submissions may fail');
  if (!iterativeReviewerRole) log.warn('Iterative Reviewer role not found; review assignment may fail');

  if (cfg.copilotHandle && copilotRole) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: cfg.copilotHandle });
    const copilot = await TC.getMemberByHandle(token, cfg.copilotHandle);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: cfg.copilotHandle, userId: copilot.userId });
    const payload = { challengeId, memberId: String(copilot.userId), roleId: copilotRole };
    log.info('REQ addResource', payload);
    await TC.addResource(token, payload);
    cancel.check();
    log.info('RES addResource', { ok: true, role: 'Copilot' });
  }

  let reviewerResourceId = reviewerResources[cfg.reviewer];
  if (!reviewerResourceId && iterativeReviewerRole) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: cfg.reviewer });
    const reviewer = await TC.getMemberByHandle(token, cfg.reviewer);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: cfg.reviewer, userId: reviewer.userId });
    const payload = { challengeId, memberId: String(reviewer.userId), roleId: iterativeReviewerRole };
    log.info('REQ addResource', payload);
    const added = await TC.addResource(token, payload);
    cancel.check();
    reviewerResourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : reviewerResourceId;
    log.info('RES addResource', { ok: true, role: 'Iterative Reviewer', resourceId: reviewerResourceId });
    if (reviewerResourceId) {
      reviewerResources[cfg.reviewer] = reviewerResourceId;
      writeLastRun({ reviewerResources });
    }
  }

  for (const handle of cfg.submitters) {
    if (!submitterRole) continue;
    cancel.check();
    log.info('REQ getMemberByHandle', { handle });
    const member = await TC.getMemberByHandle(token, handle);
    cancel.check();
    log.info('RES getMemberByHandle', { handle, userId: member.userId });
    const payload = { challengeId, memberId: String(member.userId), roleId: submitterRole };
    log.info('REQ addResource', payload);
    try {
      await TC.addResource(token, payload);
      cancel.check();
      log.info('RES addResource', { ok: true, role: 'Submitter', handle });
    } catch (error: any) {
      log.warn('Failed to add submitter resource (may already exist)', { handle, error: error?.message || String(error) });
    }
  }

  if (!reviewerResourceId) {
    throw new Error('Failed to assign iterative reviewer resource');
  }

  writeLastRun({ challengeId, reviewerResources, submissions: {} });

  return { resourceId: reviewerResourceId, handle: cfg.reviewer };
}

type SubmissionRecord = {
  id: string;
  handle: string;
  memberId: string;
  index: number;
};

type ReviewOutcome = 'pass' | 'fail';

type SubmissionHelpers = {
  queueSubmission: (handleOverride?: string) => Promise<SubmissionRecord>;
  completeReview: (step: StepName, record: SubmissionRecord, outcome: ReviewOutcome) => Promise<void>;
  ensureIterativePhase: (expectOpen: boolean, step: StepName) => Promise<void>;
  getCreatedRecords: () => SubmissionRecord[];
  submitterHandles: string[];
};

type SubmissionFlowState = {
  helpers: SubmissionHelpers;
  initialBatch: SubmissionRecord[];
};

function buildIterativeReviewComment(outcome: ReviewOutcome): string {
  if (outcome === 'pass') {
    return [
      '**Status:** ✅ Passed iterative review',
      '',
      '### Validation Notes',
      '- [x] Automated smoke tests completed',
      '- [x] Lint checks are clean',
      '',
      '`Command:` `npm run verify`',
      '',
      '![Passing evidence](https://placehold.co/640x320?text=Passing+Evidence)',
      '![Log excerpt](https://placehold.co/640x320?text=System+Logs)',
      '',
      '> _Markdown payload for validation purposes._'
    ].join('\n');
  }

  return [
    '**Status:** ❌ Changes requested',
    '',
    '### Findings',
    '1. UI regression detected on primary button.',
    '2. Automated tests surfaced a failing contract check.',
    '',
    '`Command:` `npm run lint && npm test`',
    '',
    '![Blocking issue](https://placehold.co/640x320?text=Blocking+Issue)',
    '![Error logs](https://placehold.co/640x320?text=Error+Logs)',
    '',
    '> Please address the findings and resubmit.'
  ].join('\n');
}

async function ensureIterativePhaseState(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  expectOpen: boolean,
  cancel: CancellationHelpers,
  progressStep: StepName
) {
  const desiredOpen = expectOpen ? ['Iterative Review'] : [];
  const desiredClosed = expectOpen ? [] : ['Iterative Review'];
  await stepAwaitPhasesOpen(log, token, challengeId, desiredOpen, progressStep, desiredClosed, cancel);
}

function buildReviewItems(questions: any[], outcome: ReviewOutcome) {
  return questions.map((q: any) => {
    if (!q || q.id === undefined) return null;
    const id = q.id;
    const comments = [{ content: buildIterativeReviewComment(outcome), type: 'COMMENT', sortOrder: 1 }];
    if (q.type === 'YES_NO') {
      return {
        scorecardQuestionId: id,
        initialAnswer: outcome === 'pass' ? 'YES' : 'NO',
        reviewItemComments: comments
      };
    }
    if (q.type === 'SCALE') {
      const min = typeof q.scaleMin === 'number' ? q.scaleMin : 0;
      const max = typeof q.scaleMax === 'number' ? q.scaleMax : 100;
      const value = outcome === 'pass' ? max : Math.max(min, Math.floor(max * 0.4));
      return {
        scorecardQuestionId: id,
        initialAnswer: String(value),
        reviewItemComments: comments
      };
    }
    return {
      scorecardQuestionId: id,
      initialAnswer: outcome === 'pass' ? 'YES' : 'NO',
      reviewItemComments: comments
    };
  }).filter(Boolean);
}

// toStringId moved above for reuse

function collectValues(candidate: any, keys: string[]): string[] {
  const results: string[] = [];
  for (const key of keys) {
    const value = toStringId(candidate?.[key]);
    if (value) results.push(value);
  }
  return results;
}

function extractOpenIterativePhaseIds(challenge: any): string[] {
  const phases = Array.isArray(challenge?.phases) ? challenge.phases : [];
  const ids = new Set<string>();
  for (const phase of phases) {
    if (!phase || phase.name !== 'Iterative Review' || !phase.isOpen) continue;
    for (const id of collectValues(phase, ['id', 'phaseId', 'phase_id', 'legacyId'])) {
      ids.add(id);
    }
  }
  if (!ids.size) ids.add(ITERATIVE_REVIEW_PHASE_ID);
  return [...ids];
}

async function findPendingReview(
  token: string,
  challengeId: string,
  submissionId: string,
  reviewerResourceId?: string,
  candidatePhaseIds: string[] = []
) {
  const listResponse = await TC.listReviews(token, challengeId);
  const reviews = Array.isArray(listResponse)
    ? listResponse
    : Array.isArray((listResponse as any)?.data)
      ? (listResponse as any).data
      : [];

  const normalizedSubmissionId = toStringId(submissionId);
  const normalizedResourceId = toStringId(reviewerResourceId);
  const normalizedPhaseIds = candidatePhaseIds
    .map(id => toStringId(id))
    .filter((id): id is string => Boolean(id));

  const matches: any[] = [];
  for (const rev of reviews) {
    if (!rev) continue;
    const status = typeof rev.status === 'string' ? rev.status.toUpperCase() : '';
    if (status !== 'PENDING' && status !== 'IN_PROGRESS') continue;
    const revSubmissionId = toStringId(rev.submissionId);
    if (!revSubmissionId || (normalizedSubmissionId && revSubmissionId !== normalizedSubmissionId)) continue;

    const typeHints = collectValues(rev, ['type', 'typeId', 'reviewType']);
    const metadataType = toStringId((rev.metadata as any)?.reviewType);
    const isIterative = [...typeHints, metadataType]
      .filter(Boolean)
      .some(type => type!.toUpperCase().includes('ITERATIVE'));

    const phaseCandidates = [
      ...collectValues(rev, ['phaseId', 'phase_id', 'reviewPhaseId']),
      toStringId((rev.metadata as any)?.phaseId),
      toStringId((rev.metadata as any)?.reviewPhaseId)
    ].filter(Boolean) as string[];

    matches.push({
      review: rev,
      isIterative,
      phaseMatch: normalizedPhaseIds.length === 0
        ? false
        : phaseCandidates.some(id => normalizedPhaseIds.includes(id)),
      resourceMatch: normalizedResourceId !== undefined
        ? toStringId(rev.resourceId) === normalizedResourceId
        : false
    });
  }

  const prioritized = (
    matches.find(m => m.resourceMatch && m.phaseMatch) ||
    matches.find(m => m.resourceMatch && m.isIterative) ||
    matches.find(m => m.resourceMatch) ||
    matches.find(m => m.phaseMatch && m.isIterative) ||
    matches.find(m => m.phaseMatch) ||
    matches.find(m => m.isIterative) ||
    matches[0]
  );

  return prioritized?.review;
}

type IterativeTransitionResult =
  | { status: 'closed'; pendingReview?: undefined; phaseIds: string[] }
  | { status: 'pending'; pendingReview: any; phaseIds: string[] }
  | { status: 'timeout'; pendingReview?: undefined; phaseIds: string[] };

async function awaitIterativeTransition(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  submissionId: string,
  reviewerResourceId: string,
  cancel: CancellationHelpers,
  step: StepName
): Promise<IterativeTransitionResult> {
  let attempts = 0;
  while (attempts < 12) {
    cancel.check();
    let phaseHints: string[] = [];
    try {
      const challenge = await TC.getChallenge(token, challengeId);
      phaseHints = extractOpenIterativePhaseIds(challenge);
      if (!phaseHints.length) {
        log.info('Iterative review phase closed after failing review', { step }, getStepProgress(step));
        return { status: 'closed', phaseIds: [] };
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      log.warn('Failed to refresh challenge while monitoring iterative review transition; will retry', { step, attempt: attempts + 1, error: message });
    }

    const pending = await findPendingReview(token, challengeId, submissionId, reviewerResourceId, phaseHints);
    if (pending) {
      log.info('Detected pending iterative review after failure', {
        step,
        submissionId,
        reviewId: toStringId(pending.id),
        phaseIds: phaseHints
      });
      return { status: 'pending', pendingReview: pending, phaseIds: phaseHints };
    }

    await cancel.wait(5000);
    attempts += 1;
  }

  log.warn('Timed out waiting for iterative review to close or reopen', { step, submissionId });
  return { status: 'timeout', phaseIds: [] };
}

function pickSubmitter(handles: string[], index: number) {
  const list = handles.length ? handles : [''];
  const handle = list[(index - 1) % list.length] || list[0];
  return handle;
}

async function prepareSubmissionHelpers(
  log: RunnerLogger,
  token: string,
  cfg: First2FinishConfig,
  challengeId: string,
  reviewer: ReviewerAssignment,
  cancel: CancellationHelpers
): Promise<SubmissionHelpers> {
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  const lastRun = readLastRun();
  const submissionsByHandle = { ...(lastRun.submissions || {}) } as Record<string, string[]>;
  const reviewsByKey = { ...(lastRun.reviews || {}) } as Record<string, string>;

  cancel.check();
  log.info('Preparing submission artifact from disk', { configuredPath: cfg.submissionZipPath });
  const artifact = await loadSubmissionArtifact(cfg.submissionZipPath);
  cancel.check();
  log.info('Submission artifact ready', { path: artifact.absolutePath, size: artifact.size });

  log.info('Fetching scorecard for iterative reviews', { scorecardId: cfg.scorecardId });
  const scorecard = await TC.getScorecard(token, cfg.scorecardId);
  cancel.check();
  const questions: any[] = [];
  for (const group of scorecard?.scorecardGroups || []) {
    for (const section of group?.sections || []) {
      for (const question of section?.questions || []) {
        if (question && question.id !== undefined) questions.push(question);
      }
    }
  }
  log.info('Scorecard fetched', { questionCount: questions.length });

  const createdRecords: SubmissionRecord[] = [];
  let nextSubmissionIndex = 1;

  const createSubmission = async (index: number, handleOverride?: string) => {
    const handle = handleOverride ?? pickSubmitter(cfg.submitters, index);
    cancel.check();
    log.info('REQ getMemberByHandle', { handle });
    const member = await TC.getMemberByHandle(token, handle);
    cancel.check();
    const upload = await uploadSubmissionArtifact(log, artifact);
    cancel.check();
    const payload = {
      challengeId,
      memberId: String(member.userId),
      type: 'CONTEST_SUBMISSION',
      url: upload.url
    };
    log.info('REQ createSubmission', { ...payload, storageKey: upload.key, index });
    const submission = await TC.createSubmission(token, payload);
    cancel.check();
    log.info('RES createSubmission', { id: submission.id, handle, storageKey: upload.key });
    submissionsByHandle[handle] = submissionsByHandle[handle] || [];
    submissionsByHandle[handle].push(String(submission.id));
    writeLastRun({ submissions: submissionsByHandle });
    const record: SubmissionRecord = {
      id: String(submission.id),
      handle,
      memberId: String(member.userId),
      index
    };
    createdRecords.push(record);
    return record;
  };

  const queueSubmission = async (handleOverride?: string) => {
    const record = await createSubmission(nextSubmissionIndex, handleOverride);
    nextSubmissionIndex += 1;
    return record;
  };

  const completeReview = async (step: StepName, record: SubmissionRecord, outcome: ReviewOutcome) => {
    cancel.check();
    await ensureIterativePhaseState(log, token, challengeId, true, cancel, step);
    let attempts = 0;
    let pendingReview: any | undefined;
    while (!pendingReview && attempts < 12) {
      cancel.check();
      let phaseHints: string[] = [];
      try {
        const currentChallenge = await TC.getChallenge(token, challengeId);
        phaseHints = extractOpenIterativePhaseIds(currentChallenge);
      } catch (error: any) {
        const message = error?.message || String(error);
        log.warn('Failed to refresh challenge while locating pending iterative review; will retry', { step, attempt: attempts + 1, error: message });
      }

      pendingReview = await findPendingReview(token, challengeId, record.id, reviewer.resourceId, phaseHints);
      if (pendingReview) break;
      await cancel.wait(5000);
      attempts += 1;
    }
    if (!pendingReview) {
      throw new Error(`Pending review not found for submission ${record.id}`);
    }

    const reviewItems = buildReviewItems(questions, outcome);
    const payload = {
      scorecardId: pendingReview.scorecardId || cfg.scorecardId,
      typeId: pendingReview.typeId || 'REVIEW',
      metadata: {
        outcome,
        score: outcome === 'pass' ? 100 : 10
      },
      score: outcome === 'pass' ? 100 : 10,
      isPassing: outcome === 'pass',
      status: 'COMPLETED',
      reviewDate: dayjs().toISOString(),
      committed: true,
      reviewItems
    };

    log.info('REQ updateReview', { reviewId: pendingReview.id, outcome, submissionId: record.id });
    await TC.updateReview(token, String(pendingReview.id), payload);
    cancel.check();
    log.info('Review completed', { submissionId: record.id, outcome }, getStepProgress(step));
    const key = `${reviewer.handle}:${record.handle}:${record.id}`;
    reviewsByKey[key] = String(pendingReview.id);
    writeLastRun({ reviews: reviewsByKey });
    if (outcome === 'fail') {
      await awaitIterativeTransition(log, token, challengeId, record.id, reviewer.resourceId, cancel, step);
    }
  };

  return {
    queueSubmission,
    completeReview,
    ensureIterativePhase: (expectOpen, step) => ensureIterativePhaseState(log, token, challengeId, expectOpen, cancel, step),
    getCreatedRecords: () => [...createdRecords],
    submitterHandles: [...cfg.submitters]
  };
}

async function stepLoadInitialSubmissions(
  log: RunnerLogger,
  token: string,
  cfg: First2FinishConfig,
  challengeId: string,
  reviewer: ReviewerAssignment,
  cancel: CancellationHelpers,
  initialPerSubmitter: number
): Promise<SubmissionFlowState> {
  const helpers = await prepareSubmissionHelpers(log, token, cfg, challengeId, reviewer, cancel);
  const submitterHandles = helpers.submitterHandles;
  if (!submitterHandles.length) {
    throw new Error('First2Finish flow requires at least one submitter handle');
  }

  const initialBatch: SubmissionRecord[] = [];
  log.info('Creating initial submission batch for iterative queue', {
    perSubmitter: initialPerSubmitter,
    submitters: submitterHandles,
    delayMs: INITIAL_SUBMISSION_DELAY_MS
  });

  for (let round = 0; round < initialPerSubmitter; round += 1) {
    for (let idx = 0; idx < submitterHandles.length; idx += 1) {
      cancel.check();
      const handle = submitterHandles[idx];
      const record = await helpers.queueSubmission(handle);
      log.info('Initial submission queued', {
        submissionId: record.id,
        handle: record.handle,
        round: round + 1,
        position: record.index
      });
      initialBatch.push(record);
      const isLast = round === initialPerSubmitter - 1 && idx === submitterHandles.length - 1;
      if (!isLast) {
        await cancel.wait(INITIAL_SUBMISSION_DELAY_MS);
      }
    }
  }

  log.info('Initial submission batch created', { count: initialBatch.length }, getStepProgress('loadInitialSubmissions'));

  return {
    helpers,
    initialBatch
  };
}

async function stepProcessReviews(
  log: RunnerLogger,
  state: SubmissionFlowState,
  cancel: CancellationHelpers,
  processOnlyFirst = false
): Promise<SubmissionFlowState> {
  const { helpers, initialBatch } = state;
  const toProcess = processOnlyFirst ? initialBatch.slice(0, 1) : initialBatch;
  for (const record of toProcess) {
    cancel.check();
    log.info('Processing initial submission with failing review', { submissionId: record.id, handle: record.handle });
    await helpers.completeReview('processReviews', record, 'fail');
  }

  await helpers.ensureIterativePhase(false, 'processReviews');
  log.info('Initial failing reviews completed; iterative review phase closed', { processed: toProcess.length }, getStepProgress('processReviews'));

  return state;
}

async function stepFinalizeSubmission(
  log: RunnerLogger,
  state: SubmissionFlowState,
  cancel: CancellationHelpers,
  late: boolean,
  submissionPhaseName: string,
  token: string,
  challengeId: string
) {
  const { helpers, initialBatch } = state;
  const submitterHandles = helpers.submitterHandles;
  if (!submitterHandles.length) {
    throw new Error('First2Finish flow requires at least one submitter handle');
  }

  if (late) {
    log.info('Late mode enabled: waiting for submission phase scheduled end before final submission', { submissionPhaseName });
    // Poll the challenge until the submission phase scheduledEndDate is in the past
    let waited = false;
    for (;;) {
      cancel.check();
      try {
        const ch = await TC.getChallenge(token, challengeId);
        const phases = Array.isArray(ch?.phases) ? ch.phases : [];
        const submissionPhase = phases.find((p: any) => p?.name === submissionPhaseName);
        const end = submissionPhase?.scheduledEndDate ? new Date(submissionPhase.scheduledEndDate).getTime() : null;
        const isOpen = submissionPhase?.isOpen === true;
        if (end) {
          const now = Date.now();
          if (now >= end + 1000) {
            log.info('Submission phase scheduled end reached; proceeding with late submission', { isOpen });
            break;
          }
          const waitMs = Math.min(end - now + 1000, 15_000);
          if (!waited) {
            log.info('Waiting for scheduled end of submission phase', { ms: waitMs });
            waited = true;
          }
          await cancel.wait(Math.max(1000, waitMs));
          continue;
        }
      } catch (e: any) {
        log.warn('Failed to refresh challenge while waiting for scheduled end; will retry', { error: e?.message || String(e) });
      }
      await cancel.wait(5000);
    }
  } else {
    cancel.check();
    await cancel.wait(INITIAL_SUBMISSION_DELAY_MS);
  }

  // For late submissions, validate that Registration and Submission remain open
  // until a passing iterative review is completed.
  if (late) {
    try {
      const ch = await TC.getChallenge(token, challengeId);
      const phases = Array.isArray(ch?.phases) ? ch.phases : [];
      const submissionPhase = phases.find((p: any) => p?.name === submissionPhaseName);
      const registrationPhase = phases.find((p: any) => p?.name === 'Registration');
      const submissionOpen = submissionPhase?.isOpen === true;
      const registrationOpen = registrationPhase?.isOpen === true;
      if (!submissionOpen || !registrationOpen) {
        throw new Error(`Expected Registration and ${submissionPhaseName} to remain open before passing review (late mode). Observed: registrationOpen=${registrationOpen}, submissionOpen=${submissionOpen}`);
      }
      log.info('Validated Registration and Submission are still open prior to passing review (late mode)', {
        registrationOpen,
        submissionOpen,
        submissionPhaseName
      });
    } catch (e: any) {
      // Surface the failure to the runner; this is a validation requirement for late mode.
      throw e;
    }
  }

  const finalHandle = submitterHandles[0];
  log.info(late ? 'Creating LATE final submission for passing review' : 'Creating final submission for passing review', { handle: finalHandle });
  const winningSubmission = await helpers.queueSubmission(finalHandle);
  await helpers.completeReview('finalSubmission', winningSubmission, 'pass');

  const submissionRecords = helpers.getCreatedRecords();
  log.info('Iterative submission process completed', {
    totalCreated: submissionRecords.length,
    initialFailures: initialBatch.length,
    winningSubmissionId: winningSubmission.id,
    winningHandle: winningSubmission.handle
  }, getStepProgress('finalSubmission'));

  return {
    winningSubmission,
    submissionRecords
  };
}

async function stepPostMortem(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  cancel: CancellationHelpers,
  enablePostMortem: boolean,
  scorecardIdForPostMortem: string,
  reviewerHandle: string
) {
  if (!enablePostMortem) {
    log.info('Post-Mortem disabled; skipping');
    return;
  }

  log.info('Processing Post-Mortem phase if present...');
  // Try for some time to detect and complete post-mortem reviews
  for (let attempt = 0; attempt < 12; attempt += 1) {
    cancel.check();
    const challenge = await TC.getChallenge(token, challengeId);
    logChallengeSnapshot(log, 'postMortem', challenge);
    const phases = Array.isArray(challenge?.phases) ? challenge.phases : [];
    const postMortemPhase = phases.find((p: any) => typeof p?.name === 'string' && /post[- ]?mortem/i.test(p.name));
    if (postMortemPhase?.isOpen) {
      try {
        const { readLastRun } = await import('../utils/lastRun.js');
        const lr = readLastRun();
        const reviewerResourceId = lr.reviewerResources?.[reviewerHandle];
        const resourceIds: string[] = reviewerResourceId ? [String(reviewerResourceId)] : Array.from(new Set(Object.values(lr.reviewerResources || {}).map((v: any) => String(v))));
        const listResponse = await TC.listReviews(token, challengeId);
        const existingReviews = Array.isArray(listResponse) ? listResponse : Array.isArray((listResponse as any)?.data) ? (listResponse as any).data : [];
        const pending: any[] = [];
        for (const rev of existingReviews) {
          const status = typeof rev?.status === 'string' ? rev.status.toUpperCase() : '';
          if (status !== 'PENDING' && status !== 'IN_PROGRESS') continue;
          const resId = toStringId((rev as any).resourceId);
          const phaseId = toStringId((rev as any).phaseId) || toStringId((rev as any).reviewPhaseId) || toStringId((rev as any).metadata?.phaseId);
          const isPostMortemReview = phaseId ? phaseId === (toStringId(postMortemPhase.id) || toStringId((postMortemPhase as any).phaseId)) : false;
          if (isPostMortemReview && (!resourceIds.length || (resId && resourceIds.includes(resId)))) {
            pending.push(rev);
          }
        }

        if (pending.length) {
          // Load questions from scorecard
          const scorecard = await TC.getScorecard(token, scorecardIdForPostMortem);
          const groups = scorecard?.scorecardGroups || [];
          const questions: any[] = [];
          for (const g of groups) for (const s of (g.sections || [])) for (const q of (s.questions || [])) questions.push(q);
          for (const rev of pending) {
            const items = questions.map((q: any) => {
              if (!q || q.id === undefined) return null;
              const id = q.id;
              if (q.type === 'YES_NO') {
                return { scorecardQuestionId: id, initialAnswer: 'YES', reviewItemComments: [{ content: buildIterativeReviewComment('pass'), type: 'COMMENT', sortOrder: 1 }] };
              }
              if (q.type === 'SCALE') {
                const min = typeof q.scaleMin === 'number' ? q.scaleMin : 0;
                const max = typeof q.scaleMax === 'number' ? q.scaleMax : 100;
                return { scorecardQuestionId: id, initialAnswer: String(Math.max(min, max)), reviewItemComments: [{ content: buildIterativeReviewComment('pass'), type: 'COMMENT', sortOrder: 1 }] };
              }
              return { scorecardQuestionId: id, initialAnswer: 'YES', reviewItemComments: [{ content: buildIterativeReviewComment('pass'), type: 'COMMENT', sortOrder: 1 }] };
            }).filter(Boolean);
            const payload = {
              scorecardId: rev.scorecardId || scorecardIdForPostMortem,
              typeId: rev.typeId || 'REVIEW',
              metadata: rev.metadata || {},
              status: 'COMPLETED',
              reviewDate: dayjs().toISOString(),
              committed: true,
              reviewItems: items
            };
            try {
              await TC.updateReview(token, String(rev.id), payload);
              log.info('Post-mortem review completed', { reviewId: String(rev.id) });
            } catch (e: any) {
              log.warn('Failed to complete post-mortem review', { reviewId: String(rev.id), error: e?.message || String(e) });
            }
          }
          log.info('Post-mortem step processed', { completed: pending.length });
          return; // Done
        }
      } catch (e: any) {
        log.warn('Error while processing post-mortem phase', { error: e?.message || String(e) });
      }
    }

    await cancel.wait(5000);
  }
  log.warn('Post-mortem phase not detected or no pending reviews; continuing');
}

async function stepAwaitWinner(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  winningHandle: string,
  cancel: CancellationHelpers,
  submissionPhaseName: string
) {
  log.info(`Waiting for ${submissionPhaseName} phase to close and winner assignment...`);
  while (true) {
    cancel.check();
    const challenge = await TC.getChallenge(token, challengeId);
    logChallengeSnapshot(log, 'awaitWinner', challenge);
    const phases = Array.isArray(challenge?.phases) ? challenge.phases : [];
    const submissionPhase = phases.find((p: any) => p?.name === submissionPhaseName);
    const iterativePhaseOpen = phases.some((p: any) => p?.name === 'Iterative Review' && p.isOpen);
    const postMortemOpen = phases.some((p: any) => typeof p?.name === 'string' && /post[- ]?mortem/i.test(p.name) && p.isOpen);
    const winnerHandles = Array.isArray(challenge?.winners)
      ? challenge.winners.map((w: any) => w?.handle).filter(Boolean)
      : [];
    const submissionClosed = submissionPhase ? submissionPhase.isOpen === false : false;
    const winnerAssigned = winnerHandles.includes(winningHandle);
    if (submissionClosed && winnerAssigned && !iterativePhaseOpen && !postMortemOpen) {
      log.info('Winner assigned and submission phase closed', { winner: winningHandle, submissionPhaseName }, getStepProgress('awaitWinner'));
      return challenge;
    }
    await cancel.wait(5000);
  }
}

export async function runFirst2FinishFlow(
  cfg: First2FinishConfig,
  mode: RunMode,
  toStep: StepName | undefined,
  log: RunnerLogger,
  signal?: AbortSignal,
  options?: { submissionPhaseName?: string; lateSubmission?: boolean; enablePostMortem?: boolean }
) {
  const { writeLastRun, resetLastRun } = await import('../utils/lastRun.js');
  const cancel = createCancellationHelpers(signal, log);
  resetLastRun();
  initializeStepStatuses(log);

  const submissionPhaseName = options?.submissionPhaseName ?? 'Submission';
  const isTopgear = submissionPhaseName.trim().toLowerCase() === 'topgear submission';
  const initialPerSubmitter = isTopgear ? 1 : INITIAL_SUBMISSIONS_PER_SUBMITTER;
  const isLate = Boolean(options?.lateSubmission);
  const postMortemEnabled = Boolean(options?.enablePostMortem);

  cancel.check();
  maybeStop(mode, toStep, 'token', log);
  const token = await withStep(log, 'token', () => stepToken(log, cancel));

  cancel.check();
  maybeStop(mode, toStep, 'token', log);
  const challenge = await withStep(log, 'createChallenge', () => stepCreateChallenge(log, token, cfg, cancel));
  writeLastRun({ challengeId: challenge.id, challengeName: challenge.name });

  cancel.check();
  maybeStop(mode, toStep, 'createChallenge', log);
  await withStep(log, 'updateDraft', () => stepUpdateDraft(log, token, cfg, challenge.id, cancel, submissionPhaseName));

  maybeStop(mode, toStep, 'updateDraft', log);
  cancel.check();
  await withStep(log, 'activate', () => stepActivate(log, token, challenge.id, cancel));

  maybeStop(mode, toStep, 'activate', log);
  await withStep(log, 'awaitRegSubOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Registration', submissionPhaseName], 'awaitRegSubOpen', [], cancel));

  maybeStop(mode, toStep, 'awaitRegSubOpen', log);
  const reviewer = await withStep(log, 'assignResources', () => stepAssignResources(log, token, cfg, challenge.id, cancel));

  maybeStop(mode, toStep, 'assignResources', log);
  if (isTopgear && !isLate) {
    await withStep(log, 'awaitSubmissionEnd', () => stepAwaitSubmissionScheduledEnd(log, token, challenge.id, cancel, submissionPhaseName));
    maybeStop(mode, toStep, 'awaitSubmissionEnd', log);
  }
  const submissionState = await withStep(log, 'loadInitialSubmissions', () => stepLoadInitialSubmissions(log, token, cfg, challenge.id, reviewer, cancel, initialPerSubmitter));

  maybeStop(mode, toStep, 'loadInitialSubmissions', log);
  const reviewState = await withStep(log, 'processReviews', () => stepProcessReviews(log, submissionState, cancel, isTopgear));

  maybeStop(mode, toStep, 'processReviews', log);
  const processResult = await withStep(log, 'finalSubmission', () => stepFinalizeSubmission(log, reviewState, cancel, isLate, submissionPhaseName, token, challenge.id));

  if (postMortemEnabled) {
    maybeStop(mode, toStep, 'finalSubmission', log);
    await withStep(log, 'postMortem', () => stepPostMortem(log, token, challenge.id, cancel, postMortemEnabled, cfg.scorecardId, cfg.reviewer));
    maybeStop(mode, toStep, 'postMortem', log);
  }

  maybeStop(mode, toStep, postMortemEnabled ? 'postMortem' : 'finalSubmission', log);
  await withStep(log, 'awaitWinner', () => stepAwaitWinner(log, token, challenge.id, processResult.winningSubmission.handle, cancel, submissionPhaseName));

  log.info('First2Finish flow complete', { challengeId: challenge.id }, 100);
}
