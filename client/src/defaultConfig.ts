import type {
  AppConfig,
  DesignConfig,
  First2FinishConfig,
  FullChallengeConfig,
  TopgearConfig
} from './types'

export const CONFIG_STORAGE_KEY = 'testerConfig'

const createDefaultFullConfig = (): FullChallengeConfig => ({
  challengeNamePrefix: 'Autopilot Test - ',
  projectId: 100439,
  challengeTypeId: '927abff4-7af9-4145-8ba1-577c16e64e2e',
  challengeTrackId: '9b6fc876-f4d9-4ccb-9dfd-419247628825',
  timelineTemplateId: 'a5a15ac0-aef4-41bb-97c0-a9d5192eae42',
  copilotHandle: 'TCConnCopilot',
  screener: 'marioskranitsas',
  reviewers: ['liuliquan', 'marioskranitsas'],
  submitters: ['devtest140'],
  submissionsPerSubmitter: 1,
  scorecardId: 'jEChE8UnLAxHTD',
  prizes: [500, 200, 100],
  submissionZipPath: './artifacts/sample-submission.zip'
})

const createDefaultFirst2FinishConfig = (): First2FinishConfig => ({
  challengeNamePrefix: 'Autopilot F2F - ',
  projectId: 100439,
  challengeTypeId: '927abff4-7af9-4145-8ba1-577c16e64e2e',
  challengeTrackId: '9b6fc876-f4d9-4ccb-9dfd-419247628825',
  timelineTemplateId: '0a0fed34-cb5a-47f5-b0cb-6e2ee7de8dcb',
  copilotHandle: 'TCConnCopilot',
  reviewer: 'marioskranitsas',
  submitters: ['devtest140', 'devtest141'],
  scorecardId: 'hFU73Ve2XlYCK-',
  prize: 500,
  submissionZipPath: './artifacts/sample-submission.zip'
})

const createDefaultTopgearConfig = (): TopgearConfig => ({
  challengeNamePrefix: 'Autopilot Topgear - ',
  projectId: 100439,
  challengeTypeId: '927abff4-7af9-4145-8ba1-577c16e64e2e',
  challengeTrackId: '9b6fc876-f4d9-4ccb-9dfd-419247628825',
  timelineTemplateId: '89be56ae-26a7-4bea-af03-9c9baf67017c',
  copilotHandle: 'TCConnCopilot',
  reviewer: 'marioskranitsas',
  submitters: ['devtest140'],
  scorecardId: 'hFU73Ve2XlYCK-',
  prize: 500,
  submissionZipPath: './artifacts/sample-submission.zip'
})

const createDefaultDesignConfig = (): DesignConfig => ({
  challengeNamePrefix: 'Autopilot Design - ',
  projectId: 100439,
  challengeTypeId: '927abff4-7af9-4145-8ba1-577c16e64e2e',
  challengeTrackId: '9b6fc876-f4d9-4ccb-9dfd-419247628825',
  timelineTemplateId: 'a5a15ac0-aef4-41bb-97c0-a9d5192eae42',
  copilotHandle: 'TCConnCopilot',
  reviewer: 'marioskranitsas',
  screener: 'marioskranitsas',
  screeningReviewer: 'marioskranitsas',
  approver: 'marioskranitsas',
  checkpointScreener: 'marioskranitsas',
  checkpointReviewer: 'marioskranitsas',
  submitters: ['devtest140'],
  submissionsPerSubmitter: 1,
  scorecardId: 'jEChE8UnLAxHTD',
  checkpointScorecardId: 'jEChE8UnLAxHTD',
  prizes: [500, 200, 100],
  checkpointPrizeAmount: 100,
  checkpointPrizeCount: 5,
  submissionZipPath: './artifacts/sample-submission.zip'
})

const createDefaultDesignSingleConfig = (): FullChallengeConfig => ({
  ...createDefaultFullConfig(),
  timelineTemplateId: '918f6a3e-1a63-4680-8b5e-deb95b1411e7'
})

export const createDefaultAppConfig = (): AppConfig => ({
  fullChallenge: createDefaultFullConfig(),
  first2finish: createDefaultFirst2FinishConfig(),
  topgear: createDefaultTopgearConfig(),
  designChallenge: createDefaultDesignConfig(),
  designFailScreeningChallenge: createDefaultDesignConfig(),
  designFailReviewChallenge: createDefaultDesignConfig(),
  designSingleChallenge: createDefaultDesignSingleConfig()
})
