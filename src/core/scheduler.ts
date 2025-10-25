import { Pipeline, SchedulerJob, SchedulerOptions, PipelineTrigger, ValidationError } from '../types.js';
import { logger } from '../utils/logger.js';
import { PipelineExecutor } from './executor.js';
import { stateManager } from './state.js';
import { v4 as uuidv4 } from 'uuid';

interface CronJob {
  start(): void;
  stop(): void;
  running: boolean;
}

export class PipelineScheduler {
  private jobs = new Map<string, CronJob>();
  private options: Required<SchedulerOptions>;
  private executor: PipelineExecutor;
  private isRunning: boolean = false;

  constructor(executor: PipelineExecutor, options: SchedulerOptions = {}) {
    this.executor = executor;
    this.options = {
      concurrency: options.concurrency || 10,
      timezone: options.timezone || 'UTC',
      maxRetention: options.maxRetention || 30
    };
  }

  async schedulePipeline(pipeline: Pipeline, trigger: PipelineTrigger): Promise<string> {
    if (trigger.type !== 'cron') {
      throw new ValidationError('Only cron triggers are supported for scheduling');
    }

    const jobId = uuidv4();
    const cronExpression = (trigger.config as any).expression;
    const timezone = (trigger.config as any).timezone || this.options.timezone;

    try {
      const job = this.createCronJob(cronExpression, timezone, () => 
        this.executeScheduledPipeline(pipeline, trigger, jobId)
      );

      this.jobs.set(jobId, job);

      const schedulerJob: SchedulerJob = {
        id: jobId,
        pipeline,
        trigger,
        nextRun: new Date(Date.now() + 60000), // Simplified next run
        enabled: true
      };

      await stateManager.set(`scheduler:job:${jobId}`, schedulerJob);

      logger.info('Pipeline scheduled', {
        pipeline: pipeline.name,
        jobId,
        cronExpression,
        timezone
      });

      return jobId;
    } catch (error) {
      throw new ValidationError(
        `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
        { cronExpression, timezone }
      );
    }
  }

  private createCronJob(expression: string, timezone: string, callback: () => void): CronJob {
    // Simplified cron implementation - in production, use node-cron or similar
    const interval = this.parseCronToInterval(expression);
    
    let timeoutId: NodeJS.Timeout;
    let running = false;

    const job: CronJob = {
      start() {
        if (running) return;
        running = true;
        
        const execute = () => {
          if (!running) return;
          callback();
          timeoutId = setTimeout(execute, interval);
        };
        
        timeoutId = setTimeout(execute, interval);
      },
      
      stop() {
        running = false;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      },
      
      get running() {
        return running;
      }
    };

    return job;
  }

  private parseCronToInterval(expression: string): number {
    // Basic cron to interval conversion - for demo purposes
    // In production, use a proper cron parser
    const parts = expression.split(' ');
    if (parts.length === 5) {
      // Simple conversion: * * * * * -> 1 minute
      return 60000;
    }
    return 60000; // Default 1 minute
  }

  private async executeScheduledPipeline(pipeline: Pipeline, trigger: PipelineTrigger, jobId: string): Promise<void> {
    const executionId = uuidv4();
    const runLogger = logger.child({ pipeline: pipeline.name, executionId, jobId });

    try {
      runLogger.info('Executing scheduled pipeline');
      
      const run = await this.executor.executePipeline(pipeline, executionId);
      
      runLogger.info('Scheduled pipeline execution completed', { status: run.status });

    } catch (error) {
      runLogger.error('Scheduled pipeline execution failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async unschedulePipeline(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job) {
      job.stop();
      this.jobs.delete(jobId);
      await stateManager.delete(`scheduler:job:${jobId}`);
      
      logger.info('Pipeline unscheduled', { jobId });
      return true;
    }
    return false;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    await this.loadPersistedJobs();

    for (const [jobId, job] of this.jobs) {
      job.start();
    }

    this.isRunning = true;
    this.startCleanupJob();

    logger.info('Pipeline scheduler started', { jobCount: this.jobs.size });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    for (const [jobId, job] of this.jobs) {
      job.stop();
    }

    this.isRunning = false;

    if (this.cleanupJob) {
      this.cleanupJob.stop();
    }

    logger.info('Pipeline scheduler stopped');
  }

  private async loadPersistedJobs(): Promise<void> {
    try {
      const jobKeys = await stateManager.list('scheduler:job:');
      
      for (const key of jobKeys) {
        const schedulerJob = await stateManager.get(key) as SchedulerJob;
        if (schedulerJob && schedulerJob.enabled) {
          try {
            await this.schedulePipeline(schedulerJob.pipeline, schedulerJob.trigger);
          } catch (error) {
            logger.error('Failed to reload scheduled job', {
              jobId: schedulerJob.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load persisted jobs', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private cleanupJob?: CronJob;

  private startCleanupJob(): void {
    this.cleanupJob = this.createCronJob('0 2 * * *', 'UTC', async () => {
      try {
        const deletedCount = await stateManager.cleanupOldRuns(this.options.maxRetention);
        logger.info('Scheduled cleanup completed', { deletedRunCount: deletedCount });
      } catch (error) {
        logger.error('Scheduled cleanup failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    this.cleanupJob.start();
  }

  getScheduledJobs(): SchedulerJob[] {
    const jobs: SchedulerJob[] = [];
    
    for (const [jobId, job] of this.jobs) {
      jobs.push({
        id: jobId,
        pipeline: { name: 'unknown' } as Pipeline,
        trigger: { type: 'cron', config: {} },
        nextRun: new Date(Date.now() + 60000),
        enabled: job.running
      });
    }

    return jobs;
  }

  isScheduled(pipelineName: string): boolean {
    return Array.from(this.jobs.values()).some(job => job.running);
  }

  getStatus(): { isRunning: boolean; jobCount: number; nextRuns: Date[] } {
    const nextRuns = Array.from(this.jobs.values())
      .map(() => new Date(Date.now() + 60000))
      .sort((a, b) => a.getTime() - b.getTime());

    return {
      isRunning: this.isRunning,
      jobCount: this.jobs.size,
      nextRuns: nextRuns.slice(0, 5)
    };
  }
}

export function createScheduler(
  executor: PipelineExecutor,
  options?: SchedulerOptions
): PipelineScheduler {
  return new PipelineScheduler(executor, options);
}