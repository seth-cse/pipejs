import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Logger } from '../types.js';

export interface LoggerOptions {
  level?: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
  json?: boolean;
  colors?: boolean;
  timestamp?: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  pipeline?: string;
  task?: string;
  executionId?: string;
  [key: string]: unknown;
}

export class PipeJSLogger implements Logger {
  private level: 'debug' | 'info' | 'warn' | 'error'; // FIXED: Use specific type
  private fileStream?: NodeJS.WritableStream;
  private json: boolean;
  private colors: boolean;
  private timestamp: boolean;

  private readonly levels = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  private readonly colorMap = {
    debug: '\x1b[36m', // cyan
    info: '\x1b[32m',  // green
    warn: '\x1b[33m',  // yellow
    error: '\x1b[31m', // red
    reset: '\x1b[0m'
  };

  constructor(options: LoggerOptions = {}) {
    this.level = options.level || 'info';
    this.json = options.json || false;
    this.colors = options.colors ?? true;
    this.timestamp = options.timestamp ?? true;

    if (options.file) {
      this.setupFileLogging(options.file);
    }
  }

  // ADD: Missing setter methods for CLI
  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.level = level;
  }

  setFormat(format: 'json' | 'text'): void {
    this.json = format === 'json';
    this.colors = format !== 'json';
  }

  private setupFileLogging(filePath: string): void {
    try {
      const dir = join(filePath, '..');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.fileStream = createWriteStream(filePath, { flags: 'a' });
    } catch (error) {
      this.error('Failed to setup file logging', { filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private shouldLog(level: string): boolean {
    return this.levels[level as keyof typeof this.levels] >= this.levels[this.level];
  }

  private formatMessage(level: string, message: string, meta?: Record<string, unknown>): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta
    };

    if (this.json) {
      return JSON.stringify(entry);
    }

    const parts: string[] = [];

    if (this.timestamp) {
      parts.push(entry.timestamp);
    }

    if (this.colors && process.stdout.isTTY) {
      parts.push(`${this.colorMap[level as keyof typeof this.colorMap]}${level.toUpperCase()}${this.colorMap.reset}`);
    } else {
      parts.push(level.toUpperCase());
    }

    parts.push(message);

    if (meta && Object.keys(meta).length > 0) {
      parts.push(JSON.stringify(meta, null, this.json ? 2 : 0));
    }

    return parts.join(' | ');
  }

  private write(level: string, message: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const formatted = this.formatMessage(level, message, meta);
    const output = level === 'error' ? process.stderr : process.stdout;

    output.write(formatted + '\n');

    if (this.fileStream) {
      this.fileStream.write(formatted + '\n');
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  child(meta: Record<string, unknown>): PipeJSLogger {
    const childLogger = new PipeJSLogger({
      level: this.level, // Now compatible types
      json: this.json,
      colors: this.colors,
      timestamp: this.timestamp
    });

    const originalWrite = childLogger.write.bind(childLogger);
    childLogger.write = (level: string, message: string, additionalMeta?: Record<string, unknown>) => {
      originalWrite(level, message, { ...meta, ...additionalMeta });
    };

    return childLogger;
  }

  async close(): Promise<void> {
    if (this.fileStream) {
      return new Promise((resolve) => {
        this.fileStream!.end(() => resolve());
      });
    }
  }
}

// Default logger instance
export const logger = new PipeJSLogger();

// Utility function to create pre-configured loggers
export function createLogger(options: LoggerOptions = {}): PipeJSLogger {
  return new PipeJSLogger(options);
}