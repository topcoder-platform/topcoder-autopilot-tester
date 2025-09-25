export type FlowVariant = 'full' | 'first2finish';

export type PrizeTuple = [number, number, number];

export type FullChallengeConfig = {
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
  prizes: PrizeTuple;
};

export type AppConfig = {
  fullChallenge: FullChallengeConfig;
  first2finish: First2FinishConfig;
};

export type FlowStep = {
  id: string;
  label: string;
};
