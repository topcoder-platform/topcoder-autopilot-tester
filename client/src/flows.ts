import type { FlowStep, FlowVariant } from './types';

export type FlowDefinition = {
  key: FlowVariant;
  tabLabel: string;
  steps: FlowStep[];
  defaultToStep: string;
};

const fullSteps: FlowStep[] = [
  { id: 'token', label: 'Token' },
  { id: 'createChallenge', label: 'Create Challenge' },
  { id: 'updateDraft', label: 'Update Draft' },
  { id: 'activate', label: 'Activate' },
  { id: 'awaitRegSubOpen', label: 'Await Reg/Sub Open' },
  { id: 'assignResources', label: 'Assign Resources' },
  { id: 'createSubmissions', label: 'Create Submissions' },
  { id: 'awaitReviewOpen', label: 'Await Review Open' },
  { id: 'createReviews', label: 'Create Reviews' },
  { id: 'awaitAppealsOpen', label: 'Await Appeals Open' },
  { id: 'createAppeals', label: 'Create Appeals' },
  { id: 'awaitAppealsResponseOpen', label: 'Await Appeals Response Open' },
  { id: 'appealResponses', label: 'Appeal Responses' },
  { id: 'awaitAllClosed', label: 'Await All Closed' },
  { id: 'awaitCompletion', label: 'Await Completion' }
];

const first2FinishSteps: FlowStep[] = [
  { id: 'token', label: 'Token' },
  { id: 'createChallenge', label: 'Create Challenge' },
  { id: 'updateDraft', label: 'Update Draft' },
  { id: 'activate', label: 'Activate' },
  { id: 'awaitRegSubOpen', label: 'Await Reg/Sub Open' },
  { id: 'assignResources', label: 'Assign Resources' },
  { id: 'loadInitialSubmissions', label: 'Load Submissions' },
  { id: 'processReviews', label: 'Process Reviews' },
  { id: 'finalSubmission', label: 'Final Submission' },
  { id: 'awaitWinner', label: 'Await Winner' }
];

const topgearLateSteps: FlowStep[] = [
  { id: 'token', label: 'Token' },
  { id: 'createChallenge', label: 'Create Challenge' },
  { id: 'updateDraft', label: 'Update Draft' },
  { id: 'activate', label: 'Activate' },
  { id: 'awaitRegSubOpen', label: 'Await Reg/Sub Open' },
  { id: 'assignResources', label: 'Assign Resources' },
  { id: 'loadInitialSubmissions', label: 'Load Submissions' },
  { id: 'processReviews', label: 'Process Reviews' },
  { id: 'finalSubmission', label: 'Final Submission' },
  { id: 'awaitWinner', label: 'Await Winner' }
];

export const FLOW_DEFINITIONS: Record<FlowVariant, FlowDefinition> = {
  full: {
    key: 'full',
    tabLabel: 'Full Challenge',
    steps: fullSteps,
    defaultToStep: 'activate'
  },
  design: {
    key: 'design',
    tabLabel: 'Design Challenge',
    steps: [
      { id: 'token', label: 'Token' },
      { id: 'createChallenge', label: 'Create Challenge' },
      { id: 'updateDraft', label: 'Update Draft' },
      { id: 'activate', label: 'Activate' },
      { id: 'awaitRegCkptOpen', label: 'Await Reg/Checkpoint Open' },
      { id: 'assignResources', label: 'Assign Resources' },
      { id: 'createCheckpointSubmissions', label: 'Create Checkpoint Submissions' },
      { id: 'awaitCheckpointScreeningOpen', label: 'Await Checkpoint Screening Open' },
      { id: 'createCheckpointScreeningReviews', label: 'Create Checkpoint Screening Reviews' },
      { id: 'awaitCheckpointReviewOpen', label: 'Await Checkpoint Review Open' },
      { id: 'createCheckpointReviews', label: 'Create Checkpoint Reviews' },
      { id: 'awaitSubmissionOpen', label: 'Await Submission Open' },
      { id: 'createSubmissions', label: 'Create Submissions' },
      { id: 'awaitScreeningOpen', label: 'Await Screening Open' },
      { id: 'createScreeningReviews', label: 'Create Screening Reviews' },
      { id: 'awaitReviewOpen', label: 'Await Review Open' },
      { id: 'createReviews', label: 'Create Reviews' },
      { id: 'awaitApprovalOpen', label: 'Await Approval Open' },
      { id: 'createApprovalReview', label: 'Create Approval Review' },
      { id: 'awaitAllClosed', label: 'Await All Closed' },
      { id: 'awaitCompletion', label: 'Await Completion' }
    ],
    defaultToStep: 'activate'
  },
  first2finish: {
    key: 'first2finish',
    tabLabel: 'First2Finish',
    steps: first2FinishSteps,
    defaultToStep: 'loadInitialSubmissions'
  },
  topgear: {
    key: 'topgear',
    tabLabel: 'Topgear Task',
    steps: [
      { id: 'token', label: 'Token' },
      { id: 'createChallenge', label: 'Create Challenge' },
      { id: 'updateDraft', label: 'Update Draft' },
      { id: 'activate', label: 'Activate' },
      { id: 'awaitRegSubOpen', label: 'Await Reg/Sub Open' },
      { id: 'assignResources', label: 'Assign Resources' },
      { id: 'awaitSubmissionEnd', label: 'Wait til after submission end date' },
      { id: 'loadInitialSubmissions', label: 'Load Submissions' },
      { id: 'processReviews', label: 'Process Reviews' },
      { id: 'finalSubmission', label: 'Final Submission' },
      { id: 'awaitWinner', label: 'Await Winner' }
    ],
    defaultToStep: 'loadInitialSubmissions'
  },
  topgearLate: {
    key: 'topgearLate',
    tabLabel: 'Topgear Task (Late)',
    steps: topgearLateSteps,
    defaultToStep: 'loadInitialSubmissions'
  }
};

export const ORDERED_FLOW_KEYS: FlowVariant[] = ['full', 'design', 'first2finish', 'topgear', 'topgearLate'];
