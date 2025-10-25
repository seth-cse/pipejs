import { Pipeline, Task, PipelineRun, NotificationConfig, PluginConfig } from '../types.js';
import { logger } from './logger.js';

export interface NotificationResult {
  success: boolean;
  service: string;
  error?: string;
  duration: number;
}

export interface NotificationContext {
  pipeline: Pipeline;
  run?: PipelineRun;
  task?: Task;
  event: 'start' | 'success' | 'failure' | 'cancelled';
  error?: Error;
}

export abstract class Notifier {
  abstract name: string;
  abstract send(message: string, context: NotificationContext, config: PluginConfig): Promise<NotificationResult>;

  protected formatMessage(message: string, context: NotificationContext): string {
    const { pipeline, run, task, event } = context;
    
    const parts = [
      `Pipeline: ${pipeline.name}`,
      `Event: ${event}`
    ];

    if (run) {
      parts.push(`Run: ${run.id}`);
      parts.push(`Started: ${run.startedAt.toISOString()}`);
    }

    if (task) {
      parts.push(`Task: ${task.name}`);
    }

    if (context.error) {
      parts.push(`Error: ${context.error.message}`);
    }

    return `${message}\n\n${parts.join('\n')}`;
  }
}

export class WebhookNotifier extends Notifier {
  name = 'webhook';

  async send(message: string, context: NotificationContext, config: PluginConfig): Promise<NotificationResult> {
    const startTime = Date.now();
    
    try {
      const url = config.url;
      if (typeof url !== 'string') {
        throw new Error('Webhook URL is required');
      }

      const body = {
        message: this.formatMessage(message, context),
        pipeline: context.pipeline.name,
        event: context.event,
        runId: context.run?.id,
        taskId: context.task?.id,
        timestamp: new Date().toISOString(),
        error: context.error?.message
      };

      const response = await fetch(url, {
        method: config.method as string || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.headers as Record<string, string> || {})
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return {
        success: true,
        service: this.name,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        service: this.name,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
    }
  }
}

export class ConsoleNotifier extends Notifier {
  name = 'console';

  async send(message: string, context: NotificationContext, config: PluginConfig): Promise<NotificationResult> {
    const startTime = Date.now();
    
    try {
      const formatted = this.formatMessage(message, context);
      const level = (config.level as string) || 'info';
      
      // FIXED: Type-safe logger method call
      this.logWithLevel(level, formatted, {
        notifier: this.name,
        pipeline: context.pipeline.name,
        event: context.event
      });

      return {
        success: true,
        service: this.name,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        service: this.name,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
    }
  }

  private logWithLevel(level: string, message: string, meta: Record<string, unknown>): void {
    switch (level) {
      case 'debug':
        logger.debug(message, meta);
        break;
      case 'info':
        logger.info(message, meta);
        break;
      case 'warn':
        logger.warn(message, meta);
        break;
      case 'error':
        logger.error(message, meta);
        break;
      default:
        logger.info(message, meta);
    }
  }
}

export class NotificationManager {
  private notifiers = new Map<string, Notifier>();

  constructor() {
    this.registerNotifier(new WebhookNotifier());
    this.registerNotifier(new ConsoleNotifier());
  }

  registerNotifier(notifier: Notifier): void {
    this.notifiers.set(notifier.name, notifier);
  }

  async sendNotification(
    notification: NotificationConfig, 
    context: NotificationContext
  ): Promise<NotificationResult[]> {
    const results: NotificationResult[] = [];
    const notifier = this.notifiers.get(notification.type);

    if (!notifier) {
      logger.warn(`Unknown notifier type: ${notification.type}`, {
        pipeline: context.pipeline.name,
        event: context.event
      });
      return results;
    }

    // FIXED: Handle 'cancelled' event by checking against string array
    const allowedEvents = notification.on as string[];
    if (!allowedEvents.includes(context.event)) {
      return results;
    }

    try {
      const message = notification.config.message as string || `Pipeline ${context.event}`;
      const result = await notifier.send(message, context, notification.config);
      results.push(result);

      if (!result.success) {
        logger.error(`Notification failed: ${notifier.name}`, {
          pipeline: context.pipeline.name,
          error: result.error,
          service: notifier.name
        });
      }
    } catch (error) {
      logger.error(`Unexpected error sending notification`, {
        pipeline: context.pipeline.name,
        notifier: notifier.name,
        error: error instanceof Error ? error.message : String(error)
      });

      results.push({
        success: false,
        service: notifier.name,
        error: error instanceof Error ? error.message : String(error),
        duration: 0
      });
    }

    return results;
  }

  async sendAll(
    notifications: NotificationConfig[], 
    context: NotificationContext
  ): Promise<NotificationResult[]> {
    const allResults: NotificationResult[] = [];

    for (const notification of notifications) {
      const results = await this.sendNotification(notification, context);
      allResults.push(...results);
    }

    return allResults;
  }
}

// Default notification manager instance
export const notifier = new NotificationManager();