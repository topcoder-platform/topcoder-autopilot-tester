export type FlowVariant = 'full' | 'first2finish' | 'topgear' | 'topgearLate' | 'design' | 'designSingle';

export type PrizeTuple = [number, number, number];

export type FullChallengeConfig = {
  challengeNamePrefix: string;
  projectId: number;
  challengeTypeId: string;
  challengeTrackId: string;
  timelineTemplateId: string;
  copilotHandle: string;
  screener?: string;
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
  fullChallenge: FullChallengeConfig;
  first2finish: First2FinishConfig;
  topgear: TopgearConfig;
  designChallenge: DesignConfig;
  designSingleChallenge: FullChallengeConfig;
};

export type FlowStep = {
  id: string;
  label: string;
};

export type DesignConfig = {
  challengeNamePrefix: string;
  projectId: number;
  challengeTypeId: string;
  challengeTrackId: string;
  timelineTemplateId: string;
  copilotHandle: string;
  // Reviewer handles per phase/role
  reviewer: string; // Review phase -> role "Reviewer"
  screener?: string; // Screening phase -> role "Screener"
  screeningReviewer?: string; // Legacy alias for screener
  approver?: string; // Approval phase -> role "Approver"
  checkpointScreener?: string; // Checkpoint Screening -> role "Checkpoint Screener"
  checkpointReviewer?: string; // Checkpoint Review -> role "Checkpoint Reviewer"
  submitters: string[];
  submissionsPerSubmitter: number;
  // Default scorecard for all phases, used if specific ones are not set
  scorecardId: string; // default for screening/review/approval
  // Optional specialized scorecards for each phase
  reviewScorecardId?: string;
  screeningScorecardId?: string;
  approvalScorecardId?: string;
  // Checkpoint-specific scorecards
  checkpointScorecardId: string; // backward-compat fallback
  checkpointScreeningScorecardId?: string;
  checkpointReviewScorecardId?: string;
  prizes: [number, number, number];
  submissionZipPath: string;
};
