import { Command } from 'commander';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { ScheduleCommandOptions, ValidationError } from '../../types.js';
import { parser } from '../../core/parser.js';
import { createExecutor } from '../../core/executor.js';
import { createScheduler } from '../../core/scheduler.js';
import { pluginLoader } from '../../plugins/loader.js';
import { stateManager } from '../../core/state.js';
import { logger, createLogger } from '../../utils/logger.js';

export function createScheduleCommand(): Command {
  const command = new Command('schedule')
    .description('Schedule pipelines for automatic execution')
    .argument('<config-file>', 'Path to pipeline configuration file (YAML or JSON)')
    .option('-d, --daemon', 'Run scheduler in daemon mode', false)
    .option('-p, --pid-file <file>', 'PID file for daemon mode')
    .option('-v, --verbose', 'Enable verbose logging', false)
    .option('-s, --silent', 'Suppress all output except errors', false)
    .option('-j, --json', 'Output results as JSON', false)
    .action(async (configFile: string, options: ScheduleCommandOptions) => {
      await handleScheduleCommand(configFile, options);
    });

  return command;
}


async function handleScheduleCommand(configFile: string, options: ScheduleCommandOptions): Promise<void> {
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
    
    if (parseResult.errors.length > 0) {
      throw new ValidationError(
        `Pipeline configuration validation failed:\n${parseResult.errors.join('\n')}`,
        { errors: parseResult.errors, warnings: parseResult.warnings }
      );
    }

    if (parseResult.warnings.length > 0) {
      commandLogger.warn('Pipeline configuration warnings', { warnings: parseResult.warnings });
    }

    const pipeline = parseResult.pipeline;
    const cronTriggers = pipeline.triggers?.filter(t => t.type === 'cron') || [];
    if (cronTriggers.length === 0) {
      throw new ValidationError('Pipeline must have at least one cron trigger to be scheduled');
    }

    commandLogger.info('Pipeline loaded successfully', { 
      pipeline: pipeline.name, 
      triggerCount: cronTriggers.length 
    });

    await validatePlugins(pipeline, commandLogger);

    const executor = createExecutor(pluginLoader, {
      maxConcurrency: pipeline.concurrency,
      timeout: pipeline.timeout
    });

    const scheduler = createScheduler(executor, {
      concurrency: pipeline.concurrency,
      timezone: 'UTC'
    });

    const jobIds: string[] = [];
    for (const trigger of cronTriggers) {
      try {
        const jobId = await scheduler.schedulePipeline(pipeline, trigger);
        jobIds.push(jobId);
        
        const cronConfig = trigger.config as { expression: string; timezone?: string };
        commandLogger.info('Pipeline scheduled', {
          jobId,
          cron: cronConfig.expression,
          timezone: cronConfig.timezone || 'UTC'
        });
      } catch (error) {
        commandLogger.error('Failed to schedule pipeline trigger', {
          trigger: trigger.type,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    }

    if (options.daemon) {
      await runSchedulerDaemon(scheduler, options, commandLogger);
    } else {
      await handleInteractiveScheduling(scheduler, jobIds, options, commandLogger);
    }

  } catch (error) {
    await handleCommandError(error, options, commandLogger);
    process.exit(1);
  }
}


async function validatePlugins(pipeline: any, commandLogger: typeof logger): Promise<void> {
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
}

async function runSchedulerDaemon(
  scheduler: any,
  options: ScheduleCommandOptions,
  commandLogger: typeof logger
): Promise<void> {
  commandLogger.info('Starting scheduler in daemon mode');

  if (options.pidFile) {
    const fs = await import('fs');
    fs.writeFileSync(options.pidFile, process.pid.toString());
  }

  const shutdown = async (signal: string) => {
    commandLogger.info(`Received ${signal}, shutting down scheduler`);
    await scheduler.stop();
    
    if (options.pidFile) {
      const fs = await import('fs');
      fs.unlinkSync(options.pidFile);
    }
    
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await scheduler.start();
  commandLogger.info('Scheduler daemon started and running');
  
  if (!options.json) {
    console.log('Scheduler running in daemon mode. Press Ctrl+C to stop.');
  }
}

async function handleInteractiveScheduling(
  scheduler: any,
  jobIds: string[],
  options: ScheduleCommandOptions,
  commandLogger: typeof logger
): Promise<void> {
  commandLogger.info('Starting scheduler in interactive mode');
  await scheduler.start();

  const status = scheduler.getStatus();
  
  if (options.json) {
    const output = {
      scheduled: true,
      jobCount: status.jobCount,
      jobIds,
      nextRuns: status.nextRuns.map((d: Date) => d.toISOString())
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    commandLogger.info('Scheduler started successfully', {
      jobCount: status.jobCount,
      nextRuns: status.nextRuns.slice(0, 3).map((d: Date) => d.toISOString())
    });

    console.log('\nScheduled jobs:');
    jobIds.forEach(jobId => {
      console.log(`  - ${jobId}`);
    });

    console.log('\nNext scheduled runs:');
    status.nextRuns.slice(0, 5).forEach((run: Date, index: number) => {
      console.log(`  ${index + 1}. ${run.toLocaleString()}`);
    });

    console.log('\nPress Ctrl+C to stop the scheduler');
  }

  await new Promise<void>((resolve) => {
    process.on('SIGINT', async () => {
      commandLogger.info('Stopping scheduler...');
      await scheduler.stop();
      resolve();
    });
  });
}

async function handleCommandError(
  error: unknown,
  options: ScheduleCommandOptions,
  commandLogger: typeof logger
): Promise<void> {
  if (options.json) {
    const errorOutput = {
      error: true,
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    };
    console.error(JSON.stringify(errorOutput, null, 2));
  } else {
    commandLogger.error('Command failed', {
      error: error instanceof Error ? error.message : String(error)
    });

    if (error instanceof ValidationError && error.context) {
      commandLogger.error('Validation details:', error.context);
    }

    if (options.verbose && error instanceof Error && error.stack) {
      commandLogger.debug('Stack trace:', { stack: error.stack });
    }
  }
}