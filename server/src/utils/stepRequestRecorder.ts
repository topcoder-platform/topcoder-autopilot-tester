import type { StepRequestLog } from './logger.js';

export type StepRequestLogInput = Omit<StepRequestLog, 'id' | 'timestamp' | 'outcome'> & {
  id?: string;
  timestamp?: string;
  outcome?: StepRequestLog['outcome'];
};

type Recorder = (detail: StepRequestLogInput) => StepRequestLog;

let activeRecorder: Recorder | null = null;

export function setActiveStepRequestRecorder(recorder: Recorder | null) {
  activeRecorder = recorder;
}

export function recordStepRequest(detail: StepRequestLogInput): StepRequestLog | null {
  if (!activeRecorder) return null;
  return activeRecorder(detail);
}
