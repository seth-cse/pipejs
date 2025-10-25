// src/utils/index.ts - Fixed version

export { 
  PipeJSLogger, 
  logger, 
  createLogger, 
  type LoggerOptions,
  type LogEntry 
} from './logger.js';

export { 
  SafeJSEvaluator, 
  sandbox, 
  createEvaluator,
  type SandboxOptions,
  type EvalResult 
} from './sandbox.js';

export { 
  NotificationManager,
  Notifier,
  WebhookNotifier,
  ConsoleNotifier,
  notifier,
  type NotificationResult,
  type NotificationContext 
} from './notifier.js';

export { 
  MermaidGenerator, 
  mermaid
} from './mermaid.js';

// Re-export types directly
export type { 
  MermaidOutput,
  VisualizationOptions 
} from '../types.js';