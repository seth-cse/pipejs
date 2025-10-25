/**
 * Core type definitions for PipeJS pipeline system
 */

// ==================== PLUGIN SYSTEM ====================

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  execute: (config: PluginConfig, context: ExecutionContext) => Promise<PluginResult>;
  validate?: (config: PluginConfig) => ValidationResult;
}

export interface PluginConfig {
  [key: string]: unknown;
}

export interface PluginResult {
  success: boolean;
  output?: unknown;
  error?: string;
  metadata?: {
    duration: number;
    timestamp: Date;
    [key: string]: unknown;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ==================== TASK DEFINITIONS ====================

export interface Task {
  id: string;
  name: string;
  description?: string;
  plugin: string;
  config: PluginConfig;
  dependsOn?: string[];
  retry?: {
    attempts: number;
    delay: number; // milliseconds
  };
  timeout?: number; // milliseconds
  enabled?: boolean;
}

export interface TaskExecution {
  task: Task;
  status: TaskStatus;
  result?: PluginResult;
  startedAt?: Date;
  completedAt?: Date;
  attempts: number;
}

export type TaskStatus = 
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'cancelled';

// ==================== PIPELINE DEFINITIONS ====================

export interface Pipeline {
  name: string;
  version: string;
  description?: string;
  tasks: Task[];
  triggers?: PipelineTrigger[];
  concurrency?: number;
  env?: Record<string, string>;
  timeout?: number;
}

export interface PipelineTrigger {
  type: 'cron' | 'manual' | 'webhook';
  config: CronTrigger | WebhookTrigger | ManualTrigger;
}

export interface CronTrigger {
  expression: string;
  timezone?: string;
}

export interface WebhookTrigger {
  path: string;
  method?: 'GET' | 'POST' | 'PUT';
  secret?: string;
}

export interface ManualTrigger {
  // Manual execution requires no additional config
}

// ==================== EXECUTION CONTEXT ====================

export interface ExecutionContext {
  pipeline: Pipeline;
  task: Task;
  executionId: string;
  logger: Logger;
  state: StateManager;
  previousResults: Map<string, PluginResult>;
  variables: Record<string, unknown>;
}

export interface Logger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

// ==================== STATE MANAGEMENT ====================

export interface StateManager {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (prefix: string) => Promise<string[]>;
  
  // Add the missing pipeline-specific methods
  savePipelineRun: (run: PipelineRun) => Promise<void>;
  getPipelineRun: (runId: string) => Promise<PipelineRun | null>;
  getPipelineRuns: (pipelineName: string, limit?: number) => Promise<PipelineRun[]>;
  cleanupOldRuns: (retentionDays?: number) => Promise<number>;
}

export interface PipelineRun {
  id: string;
  pipelineName: string;
  status: PipelineStatus;
  startedAt: Date;
  completedAt?: Date;
  tasks: TaskExecution[];
  trigger: PipelineTrigger;
  error?: string;
}

export type PipelineStatus = 
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'partial_success';

export interface PipelineState {
  currentRuns: Map<string, PipelineRun>;
  completedRuns: PipelineRun[];
  taskHistory: Map<string, TaskExecution[]>;
}

// ==================== SCHEDULER TYPES ====================

export interface SchedulerJob {
  id: string;
  pipeline: Pipeline;
  trigger: PipelineTrigger;
  nextRun: Date;
  enabled: boolean;
}

export interface SchedulerOptions {
  concurrency?: number;
  timezone?: string;
  maxRetention?: number; // days to keep history
}

// ==================== PARSER TYPES ====================

export interface ParserOptions {
  validate?: boolean;
  strict?: boolean;
}

export interface ParseResult {
  pipeline: Pipeline;
  warnings: string[];
  errors: string[];
}

// ==================== VISUALIZATION TYPES ====================

export interface VisualizationOptions {
  theme?: 'default' | 'dark' | 'neutral';
  orientation?: 'TB' | 'LR'; // top-bottom, left-right
  showDescriptions?: boolean;
  showStatus?: boolean;
}

export interface MermaidOutput {
  mermaid: string;
  svg?: string; // Optional: could be generated if we add SVG renderer
  errors: string[];
}

// ==================== CLI TYPES ====================

export interface CLIOptions {
  config?: string;
  verbose?: boolean;
  silent?: boolean;
  json?: boolean;
  output?: string;
}

export interface RunCommandOptions extends CLIOptions {
  task?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface ScheduleCommandOptions extends CLIOptions {
  daemon?: boolean;
  pidFile?: string;
}

export interface ValidateCommandOptions extends CLIOptions {
  strict?: boolean;
}

export interface VisualizeCommandOptions extends CLIOptions {
  output?: string;
  format?: 'mermaid' | 'svg' | 'png';
  theme?: string;
}

// ==================== ERROR TYPES ====================

export class PipeJSError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'PipeJSError';
    this.code = code;
    this.context = context;
  }
}

export class ValidationError extends PipeJSError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

export class PluginError extends PipeJSError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PLUGIN_ERROR', context);
    this.name = 'PluginError';
  }
}

export class ExecutionError extends PipeJSError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'EXECUTION_ERROR', context);
    this.name = 'ExecutionError';
  }
}

// ==================== UTILITY TYPES ====================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = 
  Pick<T, Exclude<keyof T, Keys>> 
  & {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>
  }[Keys];

export type AsyncResult<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };

// ==================== CONFIG FILE TYPES ====================

export interface PipelineConfigFile {
  pipeline: Pipeline;
  plugins?: {
    [key: string]: PluginConfig;
  };
  notifications?: NotificationConfig[];
}

export interface NotificationConfig {
  type: 'slack' | 'email' | 'webhook';
  config: PluginConfig;
  on: ('success' | 'failure' | 'start')[];
}

// ==================== EVENT TYPES ====================

export interface PipelineEvent {
  type: string;
  pipeline: string;
  executionId: string;
  timestamp: Date;
  data?: Record<string, unknown>;
}

export type TaskEvent = PipelineEvent & {
  task: string;
  taskStatus: TaskStatus;
};

export type PipelineEventType = 
  | 'pipeline.start'
  | 'pipeline.success'
  | 'pipeline.failure'
  | 'pipeline.cancelled'
  | 'task.start'
  | 'task.success'
  | 'task.failure'
  | 'task.retry'
  | 'task.skipped';