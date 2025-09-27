import dayjs from 'dayjs';
import { nanoid } from 'nanoid';
import { RunnerLogger, type StepRequestLog, type StepStatus } from '../utils/logger.js';
import { setActiveStepRequestRecorder, type StepRequestLogInput } from '../utils/stepRequestRecorder.js';
import { getToken, TC } from './topcoder.js';
import type { First2FinishConfig } from '../types/config.js';

export type RunMode = 'full' | 'toStep';
export type StepName =
  | 'token'
  | 'createChallenge'
  | 'updateDraft'
  | 'activate'
  | 'awaitRegSubOpen'
  | 'assignResources'
  | 'processSubmissions'
  | 'awaitWinner';

const STEPS: StepName[] = [
  'token',
  'createChallenge',
  'updateDraft',
  'activate',
  'awaitRegSubOpen',
  'assignResources',
  'processSubmissions',
  'awaitWinner'
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
  cancel: CancellationHelpers
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
  const updated = await TC.updateChallenge(token, challengeId, body);
  cancel.check();
  log.info('Challenge updated to DRAFT', { challengeId, request: body }, getStepProgress('updateDraft'));
  return updated;
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
  log.info('Assigning resources (copilot, reviewer, submitters)...');
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
  const reviewerRole = roleIdByName['Reviewer'];
  const copilotRole = roleIdByName['Copilot'];
  if (!submitterRole) log.warn('Submitter role not found; submissions may fail');
  if (!reviewerRole) log.warn('Reviewer role not found; review assignment may fail');

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
  if (!reviewerResourceId && reviewerRole) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: cfg.reviewer });
    const reviewer = await TC.getMemberByHandle(token, cfg.reviewer);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: cfg.reviewer, userId: reviewer.userId });
    const payload = { challengeId, memberId: String(reviewer.userId), roleId: reviewerRole };
    log.info('REQ addResource', payload);
    const added = await TC.addResource(token, payload);
    cancel.check();
    reviewerResourceId = added?.id ? String(added.id) : added?.resourceId ? String(added.resourceId) : reviewerResourceId;
    log.info('RES addResource', { ok: true, role: 'Reviewer', resourceId: reviewerResourceId });
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
    throw new Error('Failed to assign reviewer resource');
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

async function ensureIterativePhaseState(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  expectOpen: boolean,
  cancel: CancellationHelpers
) {
  const desiredOpen = expectOpen ? ['Iterative Review'] : [];
  const desiredClosed = expectOpen ? [] : ['Iterative Review'];
  await stepAwaitPhasesOpen(log, token, challengeId, desiredOpen, 'processSubmissions', desiredClosed, cancel);
}

function buildReviewItems(questions: any[], outcome: ReviewOutcome) {
  return questions.map((q: any) => {
    if (!q || q.id === undefined) return null;
    const id = q.id;
    const comments = [{ content: outcome === 'pass' ? 'Passing review' : 'Failing review', type: 'COMMENT', sortOrder: 1 }];
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

async function findPendingReview(
  token: string,
  challengeId: string,
  submissionId: string,
  reviewerResourceId: string
) {
  const listResponse = await TC.listReviews(token, challengeId);
  const reviews = Array.isArray(listResponse)
    ? listResponse
    : Array.isArray((listResponse as any)?.data)
      ? (listResponse as any).data
      : [];
  return reviews.find((rev: any) => {
    if (!rev) return false;
    const status = typeof rev.status === 'string' ? rev.status.toUpperCase() : '';
    const matchesStatus = status === 'PENDING' || status === 'IN_PROGRESS';
    const matchesSubmission = String(rev.submissionId ?? '') === submissionId;
    const matchesReviewer = String(rev.resourceId ?? '') === reviewerResourceId;
    return matchesStatus && matchesSubmission && matchesReviewer;
  });
}

function pickSubmitter(handles: string[], index: number) {
  const list = handles.length ? handles : [''];
  const handle = list[(index - 1) % list.length] || list[0];
  return handle;
}

async function stepProcessSubmissions(
  log: RunnerLogger,
  token: string,
  cfg: First2FinishConfig,
  challengeId: string,
  reviewer: ReviewerAssignment,
  cancel: CancellationHelpers
) {
  const TOTAL_SUBMISSIONS = 6;
  const FAIL_COUNT = 4;
  const PASS_INDEX = 5;
  const { readLastRun, writeLastRun } = await import('../utils/lastRun.js');
  const lr = readLastRun();
  const submissionsByHandle = { ...(lr.submissions || {}) } as Record<string, string[]>;
  const reviewsByKey = { ...(lr.reviews || {}) } as Record<string, string>;

  log.info('Fetching scorecard for iterative reviews', { scorecardId: cfg.scorecardId });
  const scorecard = await TC.getScorecard(token, cfg.scorecardId);
  cancel.check();
  const questions: any[] = [];
  for (const group of (scorecard?.scorecardGroups || [])) {
    for (const section of (group?.sections || [])) {
      for (const question of (section?.questions || [])) {
        if (question && question.id !== undefined) questions.push(question);
      }
    }
  }
  log.info('Scorecard fetched', { questionCount: questions.length });

  const createdRecords: SubmissionRecord[] = [];

  const createSubmission = async (index: number, handleOverride?: string) => {
    const handle = handleOverride ?? pickSubmitter(cfg.submitters, index);
    cancel.check();
    log.info('REQ getMemberByHandle', { handle });
    const member = await TC.getMemberByHandle(token, handle);
    cancel.check();
    const payload = {
      challengeId,
      memberId: String(member.userId),
      type: 'CONTEST_SUBMISSION',
      url: `https://example.com/f2f-submission-${handle}-${index}.zip`
    };
    log.info('REQ createSubmission', payload);
    const submission = await TC.createSubmission(token, payload);
    cancel.check();
    log.info('RES createSubmission', { id: submission.id, handle });
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

  const completeReview = async (record: SubmissionRecord, outcome: ReviewOutcome) => {
    cancel.check();
    await ensureIterativePhaseState(log, token, challengeId, true, cancel);
    let attempts = 0;
    let pendingReview: any | undefined;
    while (!pendingReview && attempts < 12) {
      cancel.check();
      pendingReview = await findPendingReview(token, challengeId, record.id, reviewer.resourceId);
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
    log.info('Review completed', { submissionId: record.id, outcome });
    const key = `${reviewer.handle}:${record.handle}:${record.id}`;
    reviewsByKey[key] = String(pendingReview.id);
    writeLastRun({ reviews: reviewsByKey });
    if (outcome === 'fail') {
      await ensureIterativePhaseState(log, token, challengeId, false, cancel);
    }
  };

  // Submission 1 - fail
  const submission1 = await createSubmission(1);
  await completeReview(submission1, 'fail');

  // Submission 2 - fail, create submission 3 while review pending
  const submission2 = await createSubmission(2);
  await ensureIterativePhaseState(log, token, challengeId, true, cancel);
  const submission3Promise = createSubmission(3);
  await completeReview(submission2, 'fail');
  const submission3 = await submission3Promise;
  await completeReview(submission3, 'fail');

  // Submission 4 - fail
  const submission4 = await createSubmission(4);
  await completeReview(submission4, 'fail');

  // Submission 5 - pass
  const submission5 = await createSubmission(5);
  // Create a sixth submission while the final review is pending to confirm autopilot behaviour
  const submission6 = await createSubmission(6);
  await completeReview(submission5, 'pass');
  log.info('Sixth submission queued after winning submission', { submissionId: submission6.id, handle: submission6.handle });

  log.info('Iterative submission process completed', {
    created: createdRecords.length,
    failures: Math.min(createdRecords.length, FAIL_COUNT),
    passIndex: PASS_INDEX
  }, getStepProgress('processSubmissions'));

  return {
    winningSubmission: submission5,
    submissionRecords: createdRecords
  };
}

async function stepAwaitWinner(
  log: RunnerLogger,
  token: string,
  challengeId: string,
  winningHandle: string,
  cancel: CancellationHelpers
) {
  log.info('Waiting for submission phase to close and winner assignment...');
  while (true) {
    cancel.check();
    const challenge = await TC.getChallenge(token, challengeId);
    logChallengeSnapshot(log, 'awaitWinner', challenge);
    const phases = Array.isArray(challenge?.phases) ? challenge.phases : [];
    const submissionPhase = phases.find((p: any) => p?.name === 'Submission');
    const iterativePhaseOpen = phases.some((p: any) => p?.name === 'Iterative Review' && p.isOpen);
    const winnerHandles = Array.isArray(challenge?.winners)
      ? challenge.winners.map((w: any) => w?.handle).filter(Boolean)
      : [];
    const submissionClosed = submissionPhase ? submissionPhase.isOpen === false : false;
    const winnerAssigned = winnerHandles.includes(winningHandle);
    if (submissionClosed && winnerAssigned && !iterativePhaseOpen) {
      log.info('Winner assigned and submission phase closed', { winner: winningHandle }, getStepProgress('awaitWinner'));
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
  await withStep(log, 'awaitRegSubOpen', () => stepAwaitPhasesOpen(log, token, challenge.id, ['Registration', 'Submission'], 'awaitRegSubOpen', [], cancel));

  maybeStop(mode, toStep, 'awaitRegSubOpen', log);
  const reviewer = await withStep(log, 'assignResources', () => stepAssignResources(log, token, cfg, challenge.id, cancel));

  maybeStop(mode, toStep, 'assignResources', log);
  const processResult = await withStep(log, 'processSubmissions', () => stepProcessSubmissions(log, token, cfg, challenge.id, reviewer, cancel));

  maybeStop(mode, toStep, 'processSubmissions', log);
  await withStep(log, 'awaitWinner', () => stepAwaitWinner(log, token, challenge.id, processResult.winningSubmission.handle, cancel));

  log.info('First2Finish flow complete', { challengeId: challenge.id }, 100);
}
