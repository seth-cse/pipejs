import { Command } from 'commander';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { 
  RunCommandOptions, 
  Pipeline, 
  PipelineRun,
  ValidationError,
  PipelineConfigFile
} from '../../types.js';
import { parser } from '../../core/parser.js';
import { createExecutor } from '../../core/executor.js';
import { pluginLoader } from '../../plugins/loader.js';
import { stateManager } from '../../core/state.js';
import { logger, createLogger } from '../../utils/logger.js';
import { notifier } from '../../utils/notifier.js';
import { v4 as uuidv4 } from 'uuid';

export function createRunCommand(): Command {
  const command = new Command('run')
    .description('Execute a pipeline from a configuration file')
    .argument('<config-file>', 'Path to pipeline configuration file (YAML or JSON)')
    .option('-t, --task <task-id>', 'Run only a specific task and its dependencies')
    .option('-f, --force', 'Force execution even if validation fails', false)
    .option('-d, --dry-run', 'Validate and plan execution without running tasks', false)
    .option('-v, --verbose', 'Enable verbose logging', false)
    .option('-s, --silent', 'Suppress all output except errors', false)
    .option('-j, --json', 'Output results as JSON', false)
    .option('-o, --output <file>', 'Write output to file instead of stdout')
    .action(async (configFile: string, options: RunCommandOptions) => {
      await handleRunCommand(configFile, options);
    });

  return command;
}
async function handleRunCommand(configFile: string, options: RunCommandOptions): Promise<void> {
  const startTime = Date.now();
  const executionId = uuidv4();

  const logLevel = options.silent ? 'error' : options.verbose ? 'debug' : 'info';
  const commandLogger = createLogger({
    level: logLevel,
    json: options.json,
    colors: !options.json && !options.silent
  });

  try {
    const resolvedPath = resolve(configFile);
    if (!existsSync(resolvedPath)) {
      throw new ValidationError(`Configuration file not found: ${resolvedPath}`);
    }

    commandLogger.info('Loading pipeline configuration', { file: resolvedPath });

    const parseResult = await parser.parseFile(resolvedPath);
    
    if (parseResult.errors.length > 0 && !options.force) {
      throw new ValidationError(
        `Pipeline configuration validation failed:\n${parseResult.errors.join('\n')}`,
        { errors: parseResult.errors, warnings: parseResult.warnings }
      );
    }

    if (parseResult.warnings.length > 0) {
      commandLogger.warn('Pipeline configuration warnings', { warnings: parseResult.warnings });
    }

    const pipeline = parseResult.pipeline;
    commandLogger.info('Pipeline loaded successfully', { 
      pipeline: pipeline.name, 
      version: pipeline.version,
      taskCount: pipeline.tasks.length 
    });

    await validatePlugins(pipeline, commandLogger);

    if (options.dryRun) {
      await handleDryRun(pipeline, options, commandLogger);
      return;
    }

    // FIXED: Remove stateManager parameter
    const executor = createExecutor(pluginLoader, {
      maxConcurrency: pipeline.concurrency,
      timeout: pipeline.timeout,
      continueOnError: false
    });

    commandLogger.info('Starting pipeline execution', { executionId });

    const run = await executor.executePipeline(pipeline, executionId);

    await handleRunResult(run, options, commandLogger, startTime);

    if (run.status !== 'success') {
      process.exit(1);
    }

  } catch (error) {
    await handleCommandError(error, options, commandLogger, startTime);
    process.exit(1);
  }
}

async function validatePlugins(pipeline: Pipeline, commandLogger: typeof logger): Promise<void> {
  const missingPlugins: string[] = [];

  for (const task of pipeline.tasks) {
    if (!task.enabled) continue;

    const plugin = await pluginLoader.loadPlugin(task.plugin);
    if (!plugin) {
      missingPlugins.push(`${task.id} (${task.plugin})`);
    }
  }

  if (missingPlugins.length > 0) {
    throw new ValidationError(
      `Missing plugins for tasks: ${missingPlugins.join(', ')}`,
      { missingPlugins }
    );
  }

  commandLogger.debug('All required plugins are available');
}

async function handleDryRun(
  pipeline: Pipeline, 
  options: RunCommandOptions, 
  commandLogger: typeof logger
): Promise<void> {
  const taskList = pipeline.tasks
    .filter(task => task.enabled)
    .map(task => ({
      id: task.id,
      name: task.name,
      plugin: task.plugin,
      dependencies: task.dependsOn || [],
      timeout: task.timeout,
      retry: task.retry
    }));

  const dryRunResult = {
    type: 'dry_run' as const,
    pipeline: pipeline.name,
    version: pipeline.version,
    taskCount: taskList.length,
    tasks: taskList,
    executionPlan: generateExecutionPlan(pipeline)
  };

  if (options.json) {
    const output = JSON.stringify(dryRunResult, null, 2);
    if (options.output) {
      const fs = await import('fs');
      fs.writeFileSync(options.output, output);
    } else {
      console.log(output);
    }
  } else {
    commandLogger.info('Dry run completed - no tasks were executed');
    commandLogger.info('Execution plan:', { 
      taskCount: dryRunResult.taskCount,
      executionOrder: dryRunResult.executionPlan 
    });
    
    if (options.verbose) {
      commandLogger.info('Task details:', { tasks: dryRunResult.tasks });
    }
  }
}

function generateExecutionPlan(pipeline: Pipeline): string[][] {
  const executed = new Set<string>();
  const plan: string[][] = [];
  const taskMap = new Map(pipeline.tasks.map(t => [t.id, t]));

  while (executed.size < pipeline.tasks.length) {
    const batch: string[] = [];

    for (const task of pipeline.tasks) {
      if (executed.has(task.id) || !task.enabled) continue;

      const dependencies = task.dependsOn || [];
      const allDepsExecuted = dependencies.every(dep => executed.has(dep));

      if (allDepsExecuted) {
        batch.push(task.id);
      }
    }

    if (batch.length === 0) {
      break;
    }

    plan.push(batch);
    batch.forEach(id => executed.add(id));
  }

  return plan;
}

async function handleRunResult(
  run: PipelineRun,
  options: RunCommandOptions,
  commandLogger: typeof logger,
  startTime: number
): Promise<void> {
  const duration = Date.now() - startTime;
  const successCount = run.tasks.filter(t => t.status === 'success').length;
  const failedCount = run.tasks.filter(t => t.status === 'failed').length;
  const skippedCount = run.tasks.filter(t => t.status === 'skipped').length;

  const summary = {
    executionId: run.id,
    pipeline: run.pipelineName,
    status: run.status,
    duration,
    tasks: {
      total: run.tasks.length,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt
  };

  if (options.json) {
    const output = JSON.stringify(summary, null, 2);
    if (options.output) {
      const fs = await import('fs');
      fs.writeFileSync(options.output, output);
    } else {
      console.log(output);
    }
  } else {
    commandLogger.info('Pipeline execution completed', summary);

    if (failedCount > 0) {
      const failedTasks = run.tasks.filter(t => t.status === 'failed');
      commandLogger.error('Failed tasks:', {
        tasks: failedTasks.map(t => ({
          id: t.task.id,
          error: t.result?.error
        }))
      });
    }

    if (options.verbose) {
      commandLogger.debug('Detailed task results:', {
        tasks: run.tasks.map(t => ({
          id: t.task.id,
          status: t.status,
          duration: t.completedAt && t.startedAt 
            ? t.completedAt.getTime() - t.startedAt.getTime()
            : undefined,
          attempts: t.attempts
        }))
      });
    }
  }
}

async function handleCommandError(
  error: unknown,
  options: RunCommandOptions,
  commandLogger: typeof logger,
  startTime: number
): Promise<void> {
  const duration = Date.now() - startTime;

  if (options.json) {
    const errorOutput = {
      error: true,
      message: error instanceof Error ? error.message : String(error),
      duration,
      timestamp: new Date().toISOString()
    };

    const output = JSON.stringify(errorOutput, null, 2);
    if (options.output) {
      const fs = await import('fs');
      fs.writeFileSync(options.output, output);
    } else {
      console.error(output);
    }
  } else {
    commandLogger.error('Command failed', {
      error: error instanceof Error ? error.message : String(error),
      duration
    });

    if (error instanceof ValidationError && error.context) {
      commandLogger.error('Validation details:', error.context);
    }

    if (options.verbose && error instanceof Error && error.stack) {
      commandLogger.debug('Stack trace:', { stack: error.stack });
    }
  }
}