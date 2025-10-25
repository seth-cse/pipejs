import { 
  Pipeline, 
  Task, 
  TaskExecution, 
  Plugin, 
  ExecutionContext, 
  PluginResult, 
  PipelineRun, 
  ExecutionError,
  PluginError 
} from '../types.js';
import { logger } from '../utils/logger.js';
import { stateManager, type StateManager } from './state.js';
import { PluginLoader } from '../plugins/loader.js';

export interface ExecutorOptions {
  maxConcurrency?: number;
  timeout?: number;
  continueOnError?: boolean;
}

export class PipelineExecutor {
  private options: Required<ExecutorOptions>;
  private pluginLoader: PluginLoader;
  private activeExecutions = new Map<string, Promise<void>>(); 

  constructor(
    pluginLoader: PluginLoader,
    options: ExecutorOptions = {}
  ) {
    this.pluginLoader = pluginLoader;
    this.options = {
      maxConcurrency: options.maxConcurrency || 5,
      timeout: options.timeout || 0,
      continueOnError: options.continueOnError || false
    };
  }

  async executePipeline(pipeline: Pipeline, executionId: string): Promise<PipelineRun> {
    const runLogger = logger.child({ pipeline: pipeline.name, executionId });
    const startTime = new Date();

    runLogger.info('Starting pipeline execution');

    const run: PipelineRun = {
      id: executionId,
      pipelineName: pipeline.name,
      status: 'running',
      startedAt: startTime,
      tasks: [],
      trigger: { type: 'manual', config: {} }
    };

    try {
      const taskExecutions = pipeline.tasks.map(task => ({
        task,
        status: 'pending' as const,
        attempts: 0
      }));

      run.tasks = taskExecutions;

      await stateManager.savePipelineRun(run);

      await this.executeTasks(pipeline, run, runLogger);

      const hasFailures = run.tasks.some(t => t.status === 'failed');
      const hasRunning = run.tasks.some(t => t.status === 'running');
      const allSkipped = run.tasks.every(t => t.status === 'skipped');

      if (hasRunning) {
        run.status = 'running';
      } else if (hasFailures) {
        run.status = 'failed';
      } else if (allSkipped) {
        run.status = 'cancelled';
      } else {
        run.status = 'success';
      }

      runLogger.info('Pipeline execution completed', { status: run.status });

    } catch (error) {
      run.status = 'failed';
      run.error = error instanceof Error ? error.message : String(error);
      runLogger.error('Pipeline execution failed', { error: run.error });
    } finally {
      run.completedAt = new Date();
      await stateManager.savePipelineRun(run);
    }

    return run;
  }

  private async executeTasks(pipeline: Pipeline, run: PipelineRun, runLogger: typeof logger): Promise<void> {
    const executed = new Set<string>();
    const taskMap = new Map(run.tasks.map(te => [te.task.id, te]));

    while (executed.size < run.tasks.length) {
      const executableTasks = this.getExecutableTasks(run.tasks, executed);

      if (executableTasks.length === 0) {
        if (executed.size < run.tasks.length) {
          const stuckTasks = run.tasks.filter(te => 
            !executed.has(te.task.id) && 
            te.status !== 'failed' && 
            te.status !== 'skipped'
          );
          runLogger.error('Pipeline deadlock detected', { stuckTasks: stuckTasks.map(t => t.task.id) });
          throw new ExecutionError('Pipeline deadlock - circular dependencies detected');
        }
        break;
      }

      const executionPromises = executableTasks.map(taskExec => 
        this.executeTaskWithConcurrency(taskExec, pipeline, run, runLogger)
      );

      await Promise.all(executionPromises);

      executableTasks.forEach(te => executed.add(te.task.id));
    }
  }

  private getExecutableTasks(taskExecutions: TaskExecution[], executed: Set<string>): TaskExecution[] {
    return taskExecutions.filter(te => {
      if (executed.has(te.task.id) || te.status !== 'pending') {
        return false;
      }

      const dependencies = te.task.dependsOn || [];
      return dependencies.every(depId => {
        const dep = taskExecutions.find(t => t.task.id === depId);
        return dep && (dep.status === 'success' || dep.status === 'skipped');
      });
    });
  }

  private async executeTaskWithConcurrency(
    taskExecution: TaskExecution,
    pipeline: Pipeline,
    run: PipelineRun,
    runLogger: typeof logger
  ): Promise<void> {
    if (this.activeExecutions.size >= this.options.maxConcurrency) {
      await this.waitForSlot();
    }

    const executionPromise = this.executeTask(taskExecution, pipeline, run.id, runLogger);
    this.activeExecutions.set(taskExecution.task.id, executionPromise);

    try {
      await executionPromise;
    } finally {
      this.activeExecutions.delete(taskExecution.task.id);
    }
  }

  private async waitForSlot(): Promise<void> {
    if (this.activeExecutions.size > 0) {
      await Promise.race(this.activeExecutions.values());
    }
  }

  private async executeTask(
    taskExecution: TaskExecution,
    pipeline: Pipeline,
    executionId: string,
    runLogger: typeof logger
  ): Promise<void> {
    const task = taskExecution.task;
    const taskLogger = runLogger.child({ task: task.id });

    if (!task.enabled) {
      taskExecution.status = 'skipped';
      taskLogger.info('Task skipped (disabled)');
      return;
    }

    taskExecution.startedAt = new Date();
    taskExecution.status = 'running';
    taskExecution.attempts = (taskExecution.attempts || 0) + 1;

    taskLogger.info('Starting task execution');

    try {
      const plugin = await this.pluginLoader.loadPlugin(task.plugin);
      if (!plugin) {
        throw new PluginError(`Plugin not found: ${task.plugin}`, { task: task.id });
      }

      const context: ExecutionContext = {
        pipeline,
        task,
        executionId,
        logger: taskLogger,
        state: stateManager,
        previousResults: new Map(),
        variables: pipeline.env || {}
      };

      const taskTimeout = task.timeout || this.options.timeout;
      let result: PluginResult;

      if (taskTimeout > 0) {
        result = await this.executeWithTimeout(plugin, task.config, context, taskTimeout, taskLogger);
      } else {
        result = await plugin.execute(task.config, context);
      }

      taskExecution.result = result;
      taskExecution.status = result.success ? 'success' : 'failed';
      taskExecution.completedAt = new Date();

      if (result.success) {
        taskLogger.info('Task completed successfully', {
          duration: taskExecution.completedAt.getTime() - taskExecution.startedAt.getTime()
        });
      } else {
        taskLogger.error('Task execution failed', { error: result.error });
        throw new ExecutionError(`Task execution failed: ${result.error}`, { task: task.id });
      }

    } catch (error) {
      taskExecution.status = 'failed';
      taskExecution.completedAt = new Date();
      taskExecution.result = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };

      taskLogger.error('Task execution failed', { 
        error: error instanceof Error ? error.message : String(error),
        attempts: taskExecution.attempts
      });

      if (task.retry && taskExecution.attempts < task.retry.attempts) {
        taskLogger.info('Scheduling task retry', { 
          attempt: taskExecution.attempts,
          maxAttempts: task.retry.attempts
        });

        taskExecution.status = 'pending';
        taskExecution.startedAt = undefined;
        taskExecution.completedAt = undefined;
        taskExecution.result = undefined;

        setTimeout(() => {
          this.executeTask(taskExecution, pipeline, executionId, runLogger)
            .catch(err => taskLogger.error('Retry execution failed', { error: err.message }));
        }, task.retry.delay);

        return;
      }

      if (!this.options.continueOnError) {
        throw error;
      }
    }
  }

  private async executeWithTimeout(
    plugin: Plugin,
    config: any,
    context: ExecutionContext,
    timeout: number,
    taskLogger: typeof logger
  ): Promise<PluginResult> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new ExecutionError(`Task execution timed out after ${timeout}ms`, { 
          task: context.task.id,
          timeout 
        }));
      }, timeout);

      plugin.execute(config, context)
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timeoutId));
    });
  }

  async cancelExecution(executionId: string): Promise<void> {
    logger.info('Execution cancellation requested', { executionId });
  }

  getActiveExecutions(): string[] {
    return Array.from(this.activeExecutions.keys());
  }
}

export function createExecutor(
  pluginLoader: PluginLoader,
  options?: ExecutorOptions
): PipelineExecutor {
  return new PipelineExecutor(pluginLoader, options);
}