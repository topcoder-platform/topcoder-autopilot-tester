
import dayjs from 'dayjs';
import { nanoid } from 'nanoid';
import { RunnerLogger, type StepRequestFailure, type StepStatus } from '../utils/logger.js';
import { getToken, TC } from './topcoder.js';

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

export type FlowConfig = {
  challengeNamePrefix: string;
  projectId: number;
  challengeTypeId: string;
  challengeTrackId: string;
  timelineTemplateId: string;
  copilotHandle: string;
  reviewers: string[];       // handles
  submitters: string[];      // handles
  submissionsPerSubmitter: number;
  scorecardId: string;
  prizes: [number, number, number];
};

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
  recordFailure: (error: any, overrides?: Partial<StepRequestFailure>) => StepRequestFailure;
  recordFailureDetail: (detail: StepRequestFailure) => StepRequestFailure;
  getFailures: () => StepRequestFailure[];
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

function extractStepFailure(error: any): StepRequestFailure {
  const response = error?.response;
  const config = response?.config ?? error?.config ?? {};
  const method = typeof config.method === 'string' ? config.method.toUpperCase() : undefined;
  const endpoint = typeof config.url === 'string' ? config.url : undefined;
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const requestBody = normalizeRequestBody(config.data);
  const failure: StepRequestFailure = {
    id: nanoid(10),
    method,
    endpoint,
    status,
    message: typeof error?.message === 'string' ? error.message : undefined,
    requestBody,
    responseBody: response?.data,
    responseHeaders: response?.headers
  };
  return failure;
}

async function withStep<T>(
  log: RunnerLogger,
  step: StepName,
  runner: (ctx: StepContext) => Promise<T>
): Promise<T> {
  const failures: StepRequestFailure[] = [];

  const emit = (status: StepStatus) => {
    log.step({ step, status, failedRequests: failures.length ? [...failures] : undefined });
  };

  const stepCtx: StepContext = {
    recordFailure: (error: any, overrides?: Partial<StepRequestFailure>) => {
      const failure: StepRequestFailure = { ...extractStepFailure(error), ...(overrides ?? {}) };
      failures.push(failure);
      emit('failure');
      return failure;
    },
    recordFailureDetail: (detail: StepRequestFailure) => {
      const failure: StepRequestFailure = { ...detail };
      if (!failure.id) failure.id = nanoid(10);
      failures.push(failure);
      emit('failure');
      return failure;
    },
    getFailures: () => [...failures]
  };

  emit('in-progress');
  try {
    const result = await runner(stepCtx);
    if (failures.length === 0) {
      emit('success');
    } else {
      emit('failure');
    }
    return result;
  } catch (error) {
    stepCtx.recordFailure(error);
    throw error;
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
    description: 'End-to-end test'
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
  const nowIso = dayjs().toISOString();
  const body = {
    typeId: cfg.challengeTypeId,
    trackId: cfg.challengeTrackId,
    name: `Challenge API Tester - ${nanoid(6)}`,
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
  const updated = await TC.updateChallenge(token, challengeId, body);
  cancel.check();
  log.info('Challenge updated to DRAFT', { challengeId, request: body }, getStepProgress('updateDraft'));
  return updated;
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
  log.info('Assigning resources (copilot, reviewers, submitters)...');
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
    Copilot: roleIdByName['Copilot']
  };
  if (!need.Submitter || !need.Reviewer || !need.Copilot) {
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
  // Reviewers
  for (const h of cfg.reviewers) {
    cancel.check();
    log.info('REQ getMemberByHandle', { handle: h });
    const mem = await TC.getMemberByHandle(token, h);
    cancel.check();
    log.info('RES getMemberByHandle', { handle: h, userId: mem.userId });
    const payload = { challengeId, memberId: String(mem.userId), roleId: need.Reviewer };
    log.info('REQ addResource', payload);
    await TC.addResource(token, payload);
    cancel.check();
    log.info('RES addResource', { ok: true });
    log.info('Added reviewer', { handle: h });
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

  const summary = {
    copilot: cfg.copilotHandle ? 1 : 0,
    reviewers: cfg.reviewers.length,
    submitters: cfg.submitters.length
  };
  log.info('Resources assigned', summary, getStepProgress('assignResources'));
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

log.info('Creating submissions...');
const lr = readLastRun();
lr.submissions = lr.submissions || {};
let createdCount = 0;
for (const h of cfg.submitters) {
  cancel.check();
  const mem = await TC.getMemberByHandle(token, h);
  cancel.check();
  for (let i=0; i<cfg.submissionsPerSubmitter; i++) {
    cancel.check();
    const payload = {
      challengeId, memberId: String(mem.userId),
      type: 'CONTEST_SUBMISSION',
      url: `https://example.com/submission-${h}-${i+1}.zip`
    };
    log.info('REQ createSubmission', payload);
    const sub = await TC.createSubmission(token, payload);
    cancel.check();
    log.info('RES createSubmission', sub);
    log.info('Submission created', { handle: h, submissionId: sub.id });
    lr.submissions[h] = lr.submissions[h] || [];
    lr.submissions[h].push(sub.id);
    writeLastRun(lr);
    createdCount += 1;
  }
}

log.info('Submissions created', { count: createdCount }, getStepProgress('createSubmissions'));
}

function randPick<T>(arr: T[]): T { return arr[Math.floor(Math.random()*arr.length)]; }
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

  // We need reviewer resource IDs and submission IDs
  // For simplicity we derive reviewer resource IDs by handle via member lookup (API will accept memberId in review creation via resourceId? If not, adjust accordingly).
  const reviewerResources: { handle: string, resourceId: string }[] = [];
  for (const h of cfg.reviewers) {
    cancel.check();
    const mem = await TC.getMemberByHandle(token, h);
    cancel.check();
    reviewerResources.push({ handle: h, resourceId: String(mem.userId) }); // NOTE: If resourceId != memberId in your env, replace with resource lookup.
  }

  // Fetch submissions list via reviews API doesn't expose; we tracked submission IDs when created, but for this simple flow we assume known via listReviews later. To keep moving, we ask the challenge to fetch submissions is not provided; so we manufacture by re-submitting map. In production, persist submission IDs when creating them.
  // Here we won't have them; in real run stepCreateSubmissions logs submission IDs; user can proceed in one run.
  // For demo completeness, we'll create one artificial map to proceed; adjust to your needs.

const lr = readLastRun();
const created = [] as any[];
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
      const reviewItems = questions.map(q => {

          if (q.type === 'YES_NO') {
            return {
              scorecardQuestionId: q.id,
              initialAnswer: randPick(['YES','NO']),
              reviewItemComments: [{
                content: `Auto review for ${q.description}`,
                type: randPick(['COMMENT','REQUIRED','RECOMMENDED']),
                sortOrder: 1
              }]
            };
          } else if (q.type === 'SCALE') {
            return {
              scorecardQuestionId: q.id,
              initialAnswer: String(randInt(q.scaleMin || 1, q.scaleMax || 10)),
              reviewItemComments: [{
                content: `Auto review score between ${q.scaleMin}-${q.scaleMax}`,
                type: randPick(['COMMENT','REQUIRED','RECOMMENDED']),
                sortOrder: 1
              }]
            };
          } else {
            return {
              scorecardQuestionId: q.id,
              initialAnswer: 'YES',
              reviewItemComments: [{ content: 'Auto answer', type: 'COMMENT', sortOrder: 1 }]
            };
          }
        });


const payload = {
  submissionId,
  scorecardId: cfg.scorecardId,
  typeId: 'REVIEW',
  metadata: {},
  status: 'COMPLETED',
  reviewDate: dayjs().toISOString(),
  committed: true,
  reviewItems
};

try {
  log.info('REQ createReview', payload);
  const r = await TC.createReview(token, payload);
  cancel.check();
  log.info('RES createReview', r);
  created.push(r);
  const key = `${rev.handle}:${submitterHandle}:${submissionId}`;
  const reviews = { ...(lr.reviews||{}), [key]: r.id };
  writeLastRun({ reviews });
  log.info('Created review', { reviewer: rev.handle, submitter: submitterHandle, submissionId, reviewId: r.id });
} catch (e:any) {
  log.warn('Create review failed (check submissionId/phaseId requirements in your env)', { reviewer: rev.handle, submitter: submitterHandle, submissionId, error: e?.message || String(e) });
  ctx?.recordFailure(e, { requestBody: payload });
}

      }
    }
  }
  log.info('Reviews created', { count: created.length }, getStepProgress('createReviews'));
  return { reviews: created, questions };
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
  const lr = readLastRun();
  const ap: string[] = lr.appeals || [];
  // For demonstration we create up to 3 appeals per review item comment id, but we need comment IDs from created reviews
  for (const r of reviewInfo.reviews) {
    cancel.check();
    for (const item of (r.reviewItems || [])) {
      cancel.check();
      for (const c of (item.reviewItemComments || [])) {
        cancel.check();
        const numAppeals = randInt(0, 3);
        for (let i=0;i<numAppeals;i++) {
          // Pick a random submitter as the appellant
          const submitterHandle = cfg.submitters[randInt(0, Math.max(0, cfg.submitters.length-1))] || '';
          if (!submitterHandle) continue;
          const mem = await TC.getMemberByHandle(token, submitterHandle);
          cancel.check();
          const payload = {
            resourceId: String(mem.userId),
            reviewItemCommentId: c.id,
            content: `Appeal ${i+1}: We believe this should be adjusted.`
          };
          try {
            log.info('REQ createAppeal', payload);
            const a = await TC.createAppeal(token, payload);
            cancel.check();
            log.info('RES createAppeal', a);
            appeals.push({ appeal: a, review: r, reviewItem: item });
            ap.push(a.id);
            writeLastRun({ appeals: ap });
            log.info('Appeal created', { appealId: a.id, by: submitterHandle });
          } catch (e:any) {
            log.warn('Create appeal failed', { error: e?.message || String(e) });
            ctx?.recordFailure(e, { requestBody: payload });
          }
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
  log.info('Creating appeal responses and updating scores when successful...');
  for (const entry of appeals) {
    cancel.check();
    const success = Math.random() < 0.5;

try {
  const payload = {
    appealId: entry.appeal.id,
    resourceId: entry.review.resourceId, // reviewer responding
    content: success ? 'Appeal accepted. Score adjusted.' : 'Appeal rejected. Score stands.',
    success
  };
  log.info('REQ respondToAppeal', payload);
  await TC.respondToAppeal(token, entry.appeal.id, payload);
  cancel.check();
  log.info('RES respondToAppeal', { ok: true, appealId: entry.appeal.id });
  log.info('Appeal response posted', { appealId: entry.appeal.id, success });

      if (success) {
        // Attempt to update the related review item score upward by 1 if numeric.
        const qId = entry.reviewItem.scorecardQuestionId;
        const initial = entry.reviewItem.initialAnswer;
        const num = Number(initial);
        const final = Number.isFinite(num) ? String(num + 1) : initial; // minimal nudge
        try {
          cancel.check();
          await TC.updateReviewItem(token, {
            scorecardQuestionId: qId,
            initialAnswer: initial,
            finalAnswer: final,
            reviewId: entry.review.id
          });
          cancel.check();
          log.info('Review item score updated', { reviewId: entry.review.id, qId, final });
        } catch (e:any) {
          log.warn('Failed to update review item score (adjust endpoint if needed)', { error: e?.message || String(e) });
          ctx?.recordFailure(e, { requestBody: { scorecardQuestionId: qId, initialAnswer: initial, finalAnswer: final, reviewId: entry.review.id } });
        }
      }
    } catch (e:any) {
      log.warn('Appeal response failed', { error: e?.message || String(e) });
      ctx?.recordFailure(e, { requestBody: { appealId: entry.appeal.id, resourceId: entry.review.resourceId, content: success ? 'Appeal accepted. Score adjusted.' : 'Appeal rejected. Score stands.', success } });
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
