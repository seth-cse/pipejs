import { readFile } from 'fs/promises';
import { load } from 'js-yaml';
import { Pipeline, ParseResult, ParserOptions, ValidationError, PipelineConfigFile } from '../types.js';
import { logger } from '../utils/logger.js';

export class PipelineParser {
  private options: Required<ParserOptions>;

  constructor(options: ParserOptions = {}) {
    this.options = {
      validate: options.validate ?? true,
      strict: options.strict ?? false
    };
  }

  async parseFile(filePath: string): Promise<ParseResult> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return this.parse(content, filePath);
    } catch (error) {
      throw new ValidationError(
        `Failed to read pipeline file: ${error instanceof Error ? error.message : String(error)}`,
        { filePath }
      );
    }
  }

  parse(content: string, source = 'string'): ParseResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    try {
      let config: PipelineConfigFile;

      // Parse YAML or JSON
      if (content.trim().startsWith('{')) {
        config = JSON.parse(content);
      } else {
        config = load(content) as PipelineConfigFile;
      }

      if (!config.pipeline) {
        throw new ValidationError('Missing "pipeline" root key in configuration');
      }

      const pipeline = this.validatePipeline(config.pipeline, warnings, errors);

      if (this.options.validate && errors.length > 0) {
        throw new ValidationError('Pipeline validation failed', { errors });
      }

      return {
        pipeline,
        warnings,
        errors: this.options.strict ? [...warnings, ...errors] : errors
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(
        `Failed to parse pipeline configuration: ${error instanceof Error ? error.message : String(error)}`,
        { source }
      );
    }
  }

  private validatePipeline(pipeline: unknown, warnings: string[], errors: string[]): Pipeline {
    if (typeof pipeline !== 'object' || pipeline === null) {
      throw new ValidationError('Pipeline must be an object');
    }

    const p = pipeline as Record<string, unknown>;

    // Required fields
    if (typeof p.name !== 'string' || !p.name.trim()) {
      errors.push('Pipeline must have a non-empty "name" string');
    }

    if (typeof p.version !== 'string' || !p.version.trim()) {
      errors.push('Pipeline must have a non-empty "version" string');
    }

    if (!Array.isArray(p.tasks)) {
      errors.push('Pipeline must have a "tasks" array');
    }

    // Optional fields validation
    if (p.description && typeof p.description !== 'string') {
      warnings.push('Pipeline description should be a string');
    }

    if (p.concurrency && (typeof p.concurrency !== 'number' || p.concurrency < 1)) {
      warnings.push('Pipeline concurrency should be a positive number, using default');
    }

    if (p.timeout && (typeof p.timeout !== 'number' || p.timeout < 0)) {
      warnings.push('Pipeline timeout should be a non-negative number, using default');
    }

    if (p.env && (typeof p.env !== 'object' || Array.isArray(p.env))) {
      warnings.push('Pipeline env should be an object, ignoring');
    }

    // Validate tasks
    const tasks = Array.isArray(p.tasks) ? this.validateTasks(p.tasks, warnings, errors) : [];

    // Validate triggers if present
    const triggers = p.triggers ? this.validateTriggers(p.triggers, warnings, errors) : undefined;

    // Build the pipeline object
    const result: Pipeline = {
      name: (p.name as string)?.trim() || 'unnamed-pipeline',
      version: (p.version as string)?.trim() || '1.0.0',
      description: p.description as string,
      tasks,
      triggers,
      concurrency: p.concurrency as number,
      env: p.env as Record<string, string>,
      timeout: p.timeout as number
    };

    // Validate DAG structure
    this.validateDAGStructure(result, errors);

    return result;
  }

  private validateTasks(tasks: unknown[], warnings: string[], errors: string[]): Pipeline['tasks'] {
    const validatedTasks: Pipeline['tasks'] = [];

    if (!Array.isArray(tasks)) {
      errors.push('Tasks must be an array');
      return validatedTasks;
    }

    if (tasks.length === 0) {
      warnings.push('Pipeline has no tasks');
    }

    const taskIds = new Set<string>();

    for (const [index, task] of tasks.entries()) {
      if (typeof task !== 'object' || task === null) {
        errors.push(`Task at index ${index} must be an object`);
        continue;
      }

      const t = task as Record<string, unknown>;

      // Required fields
      if (typeof t.id !== 'string' || !t.id.trim()) {
        errors.push(`Task at index ${index} must have a non-empty "id" string`);
        continue;
      }

      if (typeof t.name !== 'string' || !t.name.trim()) {
        warnings.push(`Task "${t.id}" should have a non-empty "name" string`);
      }

      if (typeof t.plugin !== 'string' || !t.plugin.trim()) {
        errors.push(`Task "${t.id}" must have a non-empty "plugin" string`);
        continue;
      }

      // Check for duplicate IDs
      const taskId = (t.id as string).trim();
      if (taskIds.has(taskId)) {
        errors.push(`Duplicate task ID: ${taskId}`);
        continue;
      }
      taskIds.add(taskId);

      // Validate config
      const config = t.config && typeof t.config === 'object' ? t.config : {};
      if (typeof config !== 'object') {
        warnings.push(`Task "${taskId}" config should be an object`);
      }

      // Validate dependencies
      const dependsOn = this.validateDependencies(t.dependsOn, taskId, errors);

      // Validate retry configuration
      const retry = this.validateRetryConfig(t.retry, taskId, warnings);

      // Validate timeout
      let timeout: number | undefined;
      if (t.timeout !== undefined) {
        if (typeof t.timeout === 'number' && t.timeout > 0) {
          timeout = t.timeout;
        } else {
          warnings.push(`Task "${taskId}" timeout should be a positive number, ignoring`);
        }
      }

      validatedTasks.push({
        id: taskId,
        name: (t.name as string)?.trim() || taskId,
        description: t.description as string,
        plugin: (t.plugin as string).trim(),
        config: config as Record<string, unknown>,
        dependsOn,
        retry,
        timeout,
        enabled: t.enabled !== false // default to true
      });
    }

    return validatedTasks;
  }

  private validateDependencies(dependsOn: unknown, taskId: string, errors: string[]): string[] {
    if (dependsOn === undefined || dependsOn === null) {
      return [];
    }

    if (!Array.isArray(dependsOn)) {
      errors.push(`Task "${taskId}" dependsOn should be an array of task IDs`);
      return [];
    }

    const dependencies: string[] = [];
    for (const dep of dependsOn) {
      if (typeof dep === 'string') {
        dependencies.push(dep.trim());
      } else {
        errors.push(`Task "${taskId}" dependsOn contains non-string value: ${dep}`);
      }
    }

    return dependencies;
  }

  private validateRetryConfig(retry: unknown, taskId: string, warnings: string[]): { attempts: number; delay: number } | undefined {
    if (retry === undefined || retry === null) {
      return undefined;
    }

    if (typeof retry !== 'object' || Array.isArray(retry)) {
      warnings.push(`Task "${taskId}" retry should be an object, ignoring`);
      return undefined;
    }

    const r = retry as Record<string, unknown>;
    const attempts = typeof r.attempts === 'number' ? Math.max(0, Math.floor(r.attempts)) : 0;
    const delay = typeof r.delay === 'number' ? Math.max(0, r.delay) : 1000;

    if (attempts > 0) {
      return { attempts, delay };
    }

    return undefined;
  }

  private validateTriggers(triggers: unknown, warnings: string[], errors: string[]): Pipeline['triggers'] {
    if (!Array.isArray(triggers)) {
      errors.push('Triggers must be an array');
      return undefined;
    }

    const validatedTriggers: Pipeline['triggers'] = [];

    for (const [index, trigger] of triggers.entries()) {
      if (typeof trigger !== 'object' || trigger === null) {
        errors.push(`Trigger at index ${index} must be an object`);
        continue;
      }

      const t = trigger as Record<string, unknown>;

      if (typeof t.type !== 'string') {
        errors.push(`Trigger at index ${index} must have a "type" string`);
        continue;
      }

      if (!t.config || typeof t.config !== 'object') {
        errors.push(`Trigger at index ${index} must have a "config" object`);
        continue;
      }

      switch (t.type) {
        case 'cron':
          this.validateCronTrigger(t.config, index, errors, warnings);
          break;
        case 'webhook':
          this.validateWebhookTrigger(t.config, index, errors, warnings);
          break;
        case 'manual':
          // No validation needed for manual triggers
          break;
        default:
          warnings.push(`Unknown trigger type: ${t.type} at index ${index}`);
          continue;
      }

      validatedTriggers.push({
        type: t.type as 'cron' | 'webhook' | 'manual',
        config: t.config
      });
    }

    return validatedTriggers;
  }

  private validateCronTrigger(config: unknown, index: number, errors: string[], warnings: string[]): void {
    const c = config as Record<string, unknown>;
    
    if (typeof c.expression !== 'string' || !c.expression.trim()) {
      errors.push(`Cron trigger at index ${index} must have an "expression" string`);
    }

    if (c.timezone && typeof c.timezone !== 'string') {
      warnings.push(`Cron trigger at index ${index} timezone should be a string`);
    }

    // Basic cron expression validation
    if (typeof c.expression === 'string') {
      const expr = c.expression.trim();
      const parts = expr.split(' ');
      if (parts.length !== 5) {
        warnings.push(`Cron expression "${expr}" at index ${index} should have 5 parts`);
      }
    }
  }

  private validateWebhookTrigger(config: unknown, index: number, errors: string[], warnings: string[]): void {
    const c = config as Record<string, unknown>;
    
    if (typeof c.path !== 'string' || !c.path.trim()) {
      errors.push(`Webhook trigger at index ${index} must have a "path" string`);
    }

    if (c.method && !['GET', 'POST', 'PUT'].includes(c.method as string)) {
      warnings.push(`Webhook trigger at index ${index} method should be GET, POST, or PUT`);
    }

    if (c.secret && typeof c.secret !== 'string') {
      warnings.push(`Webhook trigger at index ${index} secret should be a string`);
    }
  }

  private validateDAGStructure(pipeline: Pipeline, errors: string[]): void {
    const taskIds = new Set(pipeline.tasks.map(t => t.id));
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    // Check for circular dependencies and invalid task references
    for (const task of pipeline.tasks) {
      if (!visited.has(task.id)) {
        this.detectCycles(task.id, pipeline.tasks, visited, recursionStack, errors);
      }

      // Check if dependencies exist
      for (const depId of task.dependsOn || []) {
        if (!taskIds.has(depId)) {
          errors.push(`Task "${task.id}" depends on non-existent task: ${depId}`);
        }
      }
    }

    // Check for orphaned tasks (no dependencies and no dependents)
    const hasDependents = new Set<string>();
    for (const task of pipeline.tasks) {
      for (const depId of task.dependsOn || []) {
        hasDependents.add(depId);
      }
    }

    const orphanedTasks = pipeline.tasks.filter(task => 
      (!task.dependsOn || task.dependsOn.length === 0) && 
      !hasDependents.has(task.id)
    );

    if (orphanedTasks.length > 1) {
      errors.push(`Multiple root tasks found: ${orphanedTasks.map(t => t.id).join(', ')}. Pipeline should have a single entry point.`);
    }
  }

  private detectCycles(
    taskId: string, 
    tasks: Pipeline['tasks'], 
    visited: Set<string>, 
    recursionStack: Set<string>, 
    errors: string[]
  ): void {
    if (recursionStack.has(taskId)) {
      errors.push(`Circular dependency detected involving task: ${taskId}`);
      return;
    }

    if (visited.has(taskId)) {
      return;
    }

    visited.add(taskId);
    recursionStack.add(taskId);

    const task = tasks.find(t => t.id === taskId);
    if (task) {
      for (const depId of task.dependsOn || []) {
        this.detectCycles(depId, tasks, visited, recursionStack, errors);
      }
    }

    recursionStack.delete(taskId);
  }
}

// Default parser instance
export const parser = new PipelineParser();