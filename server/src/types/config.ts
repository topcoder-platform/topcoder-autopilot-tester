import fs from 'fs';

export type PrizeTuple = [number, number, number];

export type FlowConfig = {
  challengeNamePrefix: string;
  projectId: number;
  challengeTypeId: string;
  challengeTrackId: string;
  timelineTemplateId: string;
  copilotHandle: string;
  reviewers: string[];
  submitters: string[];
  submissionsPerSubmitter: number;
  scorecardId: string;
  prizes: PrizeTuple;
  submissionZipPath: string;
};

export type First2FinishConfig = {
  challengeNamePrefix: string;
  projectId: number;
  challengeTypeId: string;
  challengeTrackId: string;
  timelineTemplateId: string;
  copilotHandle: string;
  reviewer: string;
  submitters: string[];
  scorecardId: string;
  prize: number;
  submissionZipPath: string;
};

export type TopgearConfig = First2FinishConfig;

export type AppConfig = {
  fullChallenge: FlowConfig;
  first2finish: First2FinishConfig;
  topgear: TopgearConfig;
};

export const FIRST2FINISH_TIMELINE_TEMPLATE_ID = '0a0fed34-cb5a-47f5-b0cb-6e2ee7de8dcb';
export const TOPGEAR_TIMELINE_TEMPLATE_ID = '89be56ae-26a7-4bea-af03-9c9baf67017c';

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  challengeNamePrefix: 'Autopilot Test - ',
  projectId: 100439,
  challengeTypeId: '927abff4-7af9-4145-8ba1-577c16e64e2e',
  challengeTrackId: '9b6fc876-f4d9-4ccb-9dfd-419247628825',
  timelineTemplateId: 'a5a15ac0-aef4-41bb-97c0-a9d5192eae42',
  copilotHandle: 'TCConnCopilot',
  reviewers: ['liuliquan', 'marioskranitsas'],
  submitters: ['devtest140'],
  submissionsPerSubmitter: 1,
  scorecardId: 'jEChE8UnLAxHTD',
  prizes: [500, 200, 100],
  submissionZipPath: './artifacts/sample-submission.zip'
};

export const DEFAULT_FIRST2FINISH_CONFIG: First2FinishConfig = {
  challengeNamePrefix: 'Autopilot F2F - ',
  projectId: 100439,
  challengeTypeId: '927abff4-7af9-4145-8ba1-577c16e64e2e',
  challengeTrackId: '9b6fc876-f4d9-4ccb-9dfd-419247628825',
  timelineTemplateId: FIRST2FINISH_TIMELINE_TEMPLATE_ID,
  copilotHandle: 'TCConnCopilot',
  reviewer: 'marioskranitsas',
  submitters: ['devtest140', 'devtest141'],
  scorecardId: 'hFU73Ve2XlYCK-',
  prize: 500,
  submissionZipPath: './artifacts/sample-submission.zip'
};

export const DEFAULT_TOPGEAR_CONFIG: TopgearConfig = {
  challengeNamePrefix: 'Autopilot Topgear - ',
  projectId: 100439,
  challengeTypeId: '927abff4-7af9-4145-8ba1-577c16e64e2e',
  challengeTrackId: '9b6fc876-f4d9-4ccb-9dfd-419247628825',
  timelineTemplateId: TOPGEAR_TIMELINE_TEMPLATE_ID,
  copilotHandle: 'TCConnCopilot',
  reviewer: 'marioskranitsas',
  submitters: ['devtest140', 'devtest141'],
  scorecardId: 'hFU73Ve2XlYCK-',
  prize: 500,
  submissionZipPath: './artifacts/sample-submission.zip'
};

function ensurePrizeTuple(input: unknown, fallback: PrizeTuple): PrizeTuple {
  if (!Array.isArray(input)) return fallback;
  const values = input
    .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : null))
    .filter((value): value is number => value !== null);
  if (values.length >= 3) {
    return [values[0], values[1], values[2]];
  }
  if (values.length === 2) {
    return [values[0], values[1], fallback[2]];
  }
  if (values.length === 1) {
    return [values[0], fallback[1], fallback[2]];
  }
  return fallback;
}

function ensureSinglePrize(input: unknown, fallback: number): number {
  const coerce = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  };
  const direct = coerce(input);
  if (direct !== null) {
    return direct;
  }
  if (Array.isArray(input)) {
    for (const entry of input) {
      const value = coerce(entry);
      if (value !== null) {
        return value;
      }
    }
  }
  return fallback;
}

function ensureString(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function ensureStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const result = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return result.length ? result : fallback;
}

function ensureNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  return fallback;
}

function normalizeIterativeConfig(
  value: unknown,
  fallback: First2FinishConfig,
  timelineTemplateId: string,
  minSubmitters = 2
): First2FinishConfig {
  const base = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const submitters = ensureStringArray(base.submitters, fallback.submitters);
  const uniqueSubmitters = Array.from(new Set(submitters));
  const finalSubmitters = uniqueSubmitters.length >= minSubmitters ? uniqueSubmitters : fallback.submitters;
  const normalized: First2FinishConfig = {
    challengeNamePrefix: ensureString(base.challengeNamePrefix, fallback.challengeNamePrefix),
    projectId: ensureNumber(base.projectId, fallback.projectId),
    challengeTypeId: ensureString(base.challengeTypeId, fallback.challengeTypeId),
    challengeTrackId: ensureString(base.challengeTrackId, fallback.challengeTrackId),
    timelineTemplateId,
    copilotHandle: ensureString(base.copilotHandle, fallback.copilotHandle),
    reviewer: ensureString(base.reviewer, fallback.reviewer),
    submitters: finalSubmitters,
    scorecardId: ensureString(base.scorecardId, fallback.scorecardId),
    prize: ensureSinglePrize(base.prize ?? (base as any).prizes, fallback.prize),
    submissionZipPath: ensureString(base.submissionZipPath, fallback.submissionZipPath)
  };
  return normalized;
}

export function normalizeFlowConfig(value: unknown): FlowConfig {
  const base = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const fallback = DEFAULT_FLOW_CONFIG;
  return {
    challengeNamePrefix: ensureString(base.challengeNamePrefix, fallback.challengeNamePrefix),
    projectId: ensureNumber(base.projectId, fallback.projectId),
    challengeTypeId: ensureString(base.challengeTypeId, fallback.challengeTypeId),
    challengeTrackId: ensureString(base.challengeTrackId, fallback.challengeTrackId),
    timelineTemplateId: ensureString(base.timelineTemplateId, fallback.timelineTemplateId),
    copilotHandle: ensureString(base.copilotHandle, fallback.copilotHandle),
    reviewers: ensureStringArray(base.reviewers, fallback.reviewers),
    submitters: ensureStringArray(base.submitters, fallback.submitters),
    submissionsPerSubmitter: ensureNumber(base.submissionsPerSubmitter, fallback.submissionsPerSubmitter),
    scorecardId: ensureString(base.scorecardId, fallback.scorecardId),
    prizes: ensurePrizeTuple(base.prizes, fallback.prizes),
    submissionZipPath: ensureString(base.submissionZipPath, fallback.submissionZipPath)
  };
}

export function normalizeFirst2FinishConfig(value: unknown): First2FinishConfig {
  return normalizeIterativeConfig(value, DEFAULT_FIRST2FINISH_CONFIG, FIRST2FINISH_TIMELINE_TEMPLATE_ID);
}

export function normalizeTopgearConfig(value: unknown): TopgearConfig {
  return normalizeIterativeConfig(value, DEFAULT_TOPGEAR_CONFIG, TOPGEAR_TIMELINE_TEMPLATE_ID);
}

export function normalizeAppConfig(raw: unknown): AppConfig {
  if (!raw || typeof raw !== 'object') {
    return {
      fullChallenge: DEFAULT_FLOW_CONFIG,
      first2finish: DEFAULT_FIRST2FINISH_CONFIG,
      topgear: DEFAULT_TOPGEAR_CONFIG
    };
  }

  const data = raw as Record<string, unknown>;
  const hasNewStructure = ['fullChallenge', 'first2finish', 'topgear'].some(key => Object.prototype.hasOwnProperty.call(data, key));

  if (!hasNewStructure) {
    const flowConfig = normalizeFlowConfig(data);
    const reviewer = flowConfig.reviewers.length ? flowConfig.reviewers[0] : DEFAULT_FIRST2FINISH_CONFIG.reviewer;
    const f2f: First2FinishConfig = normalizeFirst2FinishConfig({
      ...data,
      reviewer,
      timelineTemplateId: FIRST2FINISH_TIMELINE_TEMPLATE_ID,
      submitters: ensureStringArray((data as any).submitters, DEFAULT_FIRST2FINISH_CONFIG.submitters)
    });
    const topgear = normalizeTopgearConfig({
      ...data,
      reviewer,
      timelineTemplateId: TOPGEAR_TIMELINE_TEMPLATE_ID,
      submitters: ensureStringArray((data as any).submitters, DEFAULT_TOPGEAR_CONFIG.submitters)
    });
    return { fullChallenge: flowConfig, first2finish: f2f, topgear };
  }

  const full = normalizeFlowConfig(data.fullChallenge);
  const f2f = normalizeFirst2FinishConfig(data.first2finish);
  const topgear = normalizeTopgearConfig(data.topgear);
  return { fullChallenge: full, first2finish: f2f, topgear };
}

export function readAppConfigFile(filePath: string): AppConfig {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        fullChallenge: DEFAULT_FLOW_CONFIG,
        first2finish: DEFAULT_FIRST2FINISH_CONFIG,
        topgear: DEFAULT_TOPGEAR_CONFIG
      };
    }
    const rawFile = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(rawFile);
    return normalizeAppConfig(parsed);
  } catch (error) {
    console.warn('Failed to read config file, falling back to defaults', error);
    return {
      fullChallenge: DEFAULT_FLOW_CONFIG,
      first2finish: DEFAULT_FIRST2FINISH_CONFIG,
      topgear: DEFAULT_TOPGEAR_CONFIG
    };
  }
}

export function writeAppConfigFile(filePath: string, config: AppConfig) {
  const finalConfig: AppConfig = {
    fullChallenge: normalizeFlowConfig(config.fullChallenge),
    first2finish: normalizeFirst2FinishConfig(config.first2finish),
    topgear: normalizeTopgearConfig(config.topgear)
  };
  fs.writeFileSync(filePath, JSON.stringify(finalConfig, null, 2));
}
