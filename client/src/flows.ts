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

export const FLOW_DEFINITIONS: Record<FlowVariant, FlowDefinition> = {
  full: {
    key: 'full',
    tabLabel: 'Full Challenge',
    steps: fullSteps,
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
    steps: first2FinishSteps,
    defaultToStep: 'loadInitialSubmissions'
  }
};

export const ORDERED_FLOW_KEYS: FlowVariant[] = ['full', 'first2finish', 'topgear'];
