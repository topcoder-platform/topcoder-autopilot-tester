
import EventEmitter from 'eventemitter3';

export type LogEvent = { level: 'info' | 'warn' | 'error' ; message: string; data?: any; progress?: number };

export type StepStatus = 'pending' | 'in-progress' | 'success' | 'failure';

export type StepRequestLog = {
  id: string;
  method?: string;
  endpoint?: string;
  status?: number;
  message?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: Record<string, unknown>;
  timestamp?: string;
  durationMs?: number;
  outcome: 'success' | 'failure';
};

export type StepEvent = {
  type: 'step';
  step: string;
  status: StepStatus;
  requests?: StepRequestLog[];
  failedRequests?: StepRequestLog[];
  timestamp: string;
};

export class RunnerLogger extends EventEmitter {
  log(level: LogEvent['level'], message: string, data?: any, progress?: number) {
    this.emit('log', { level, message, data, progress } as LogEvent);
  }
  info(message: string, data?: any, progress?: number) { this.log('info', message, data, progress); }
  warn(message: string, data?: any, progress?: number) { this.log('warn', message, data, progress); }
  error(message: string, data?: any, progress?: number) { this.log('error', message, data, progress); }

  step(event: {
    step: string;
    status: StepStatus;
    requests?: StepRequestLog[];
    failedRequests?: StepRequestLog[];
    timestamp?: string;
  }) {
    const payload: StepEvent = {
      type: 'step',
      step: event.step,
      status: event.status,
      timestamp: event.timestamp ?? new Date().toISOString(),
      requests: event.requests,
      failedRequests: event.failedRequests
    };
    this.emit('step', payload);
  }
}
