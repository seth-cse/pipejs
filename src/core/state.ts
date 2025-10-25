import { readFile, writeFile, mkdir, access, constants } from 'fs/promises';
import { join, dirname } from 'path';
import sqlite3 from 'sqlite3';
const { Database } = sqlite3;
import { 
  StateManager, 
  PipelineRun, 
  TaskExecution, 
  PipeJSError 
} from '../types.js';
import { logger } from '../utils/logger.js';

export interface FileStateOptions {
  basePath?: string;
  filename?: string;
}

export interface SQLiteStateOptions {
  filePath?: string;
  tablePrefix?: string;
}

export class FileStateManager implements StateManager {
  private basePath: string;
  private filename: string;

  constructor(options: FileStateOptions = {}) {
    this.basePath = options.basePath || join(process.cwd(), '.pipejs');
    this.filename = options.filename || 'state.json';
  }

  private get filePath(): string {
    return join(this.basePath, this.filename);
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await access(this.basePath, constants.F_OK);
    } catch {
      await mkdir(this.basePath, { recursive: true });
    }
  }

  private async loadState(): Promise<Record<string, unknown>> {
    try {
      await this.ensureDirectory();
      const content = await readFile(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw new PipeJSError(
        `Failed to load state: ${error instanceof Error ? error.message : String(error)}`,
        'STATE_LOAD_ERROR',
        { filePath: this.filePath }
      );
    }
  }

  private async saveState(state: Record<string, unknown>): Promise<void> {
    try {
      await this.ensureDirectory();
      await writeFile(this.filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (error) {
      throw new PipeJSError(
        `Failed to save state: ${error instanceof Error ? error.message : String(error)}`,
        'STATE_SAVE_ERROR',
        { filePath: this.filePath }
      );
    }
  }

  async get(key: string): Promise<unknown> {
    const state = await this.loadState();
    return state[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    const state = await this.loadState();
    state[key] = value;
    await this.saveState(state);
  }

  async delete(key: string): Promise<void> {
    const state = await this.loadState();
    delete state[key];
    await this.saveState(state);
  }

  async list(prefix: string): Promise<string[]> {
    const state = await this.loadState();
    return Object.keys(state).filter(key => key.startsWith(prefix));
  }

  async savePipelineRun(run: PipelineRun): Promise<void> {
    const runs = (await this.get('pipeline_runs') as PipelineRun[]) || [];
    const existingIndex = runs.findIndex(r => r.id === run.id);
    
    if (existingIndex >= 0) {
      runs[existingIndex] = run;
    } else {
      runs.push(run);
    }

    await this.set('pipeline_runs', runs);
  }

  async getPipelineRun(runId: string): Promise<PipelineRun | null> {
    const runs = (await this.get('pipeline_runs') as PipelineRun[]) || [];
    return runs.find(r => r.id === runId) || null;
  }

  async getPipelineRuns(pipelineName: string, limit = 100): Promise<PipelineRun[]> {
    const runs = (await this.get('pipeline_runs') as PipelineRun[]) || [];
    return runs
      .filter(r => r.pipelineName === pipelineName)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  async cleanupOldRuns(retentionDays = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const runs = (await this.get('pipeline_runs') as PipelineRun[]) || [];
    const keptRuns = runs.filter(run => run.startedAt > cutoff);
    const deletedCount = runs.length - keptRuns.length;

    if (deletedCount > 0) {
      await this.set('pipeline_runs', keptRuns);
      logger.info(`Cleaned up ${deletedCount} pipeline runs older than ${retentionDays} days`);
    }

    return deletedCount;
  }
}

export class SQLiteStateManager implements StateManager {
  private db: sqlite3.Database; // FIXED: Use sqlite3.Database type
  private tablePrefix: string;
  private initialized: boolean = false;

  constructor(options: SQLiteStateOptions = {}) {
    const filePath = options.filePath || join(process.cwd(), '.pipejs', 'state.db');
    this.tablePrefix = options.tablePrefix || 'pipejs_';
    
    mkdir(dirname(filePath), { recursive: true }).catch(() => {});
    this.db = new Database(filePath);
  }

  private get tableName(): string {
    return `${this.tablePrefix}state`;
  }

  private get runsTableName(): string {
    return `${this.tablePrefix}runs`;
  }

  private get tasksTableName(): string {
    return `${this.tablePrefix}tasks`;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err: Error | null) => { 
        if (err) {
          reject(new PipeJSError(`Failed to create state table: ${err.message}`, 'DB_INIT_ERROR'));
          return;
        }

        this.db.run(`
          CREATE TABLE IF NOT EXISTS ${this.runsTableName} (
            id TEXT PRIMARY KEY,
            pipeline_name TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at DATETIME NOT NULL,
            completed_at DATETIME,
            trigger_type TEXT NOT NULL,
            trigger_config TEXT,
            error_text TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (err: Error | null) => { 
          if (err) {
            reject(new PipeJSError(`Failed to create runs table: ${err.message}`, 'DB_INIT_ERROR'));
            return;
          }

          this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tasksTableName} (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL,
              task_id TEXT NOT NULL,
              task_name TEXT NOT NULL,
              status TEXT NOT NULL,
              started_at DATETIME,
              completed_at DATETIME,
              attempts INTEGER DEFAULT 1,
              result_output TEXT,
              result_error TEXT,
              result_metadata TEXT,
              FOREIGN KEY (run_id) REFERENCES ${this.runsTableName} (id) ON DELETE CASCADE
            )
          `, (err: Error | null) => { 
            if (err) {
              reject(new PipeJSError(`Failed to create tasks table: ${err.message}`, 'DB_INIT_ERROR'));
              return;
            }

            this.initialized = true;
            resolve();
          });
        });
      });
    });
  }

  private runQuery(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err: Error | null) { 
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private getRow<T>(sql: string, params: any[] = []): Promise<T | null> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err: Error | null, row: T) => { 
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  private getAllRows<T>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err: Error | null, rows: T[]) => { 
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async get(key: string): Promise<unknown> {
    await this.initialize();
    const row = await this.getRow<{ value: string }>(
      `SELECT value FROM ${this.tableName} WHERE key = ?`,
      [key]
    );
    return row ? JSON.parse(row.value) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.initialize();
    const serialized = JSON.stringify(value);
    await this.runQuery(
      `INSERT OR REPLACE INTO ${this.tableName} (key, value) VALUES (?, ?)`,
      [key, serialized]
    );
  }

  async delete(key: string): Promise<void> {
    await this.initialize();
    await this.runQuery(`DELETE FROM ${this.tableName} WHERE key = ?`, [key]);
  }

  async list(prefix: string): Promise<string[]> {
    await this.initialize();
    const rows = await this.getAllRows<{ key: string }>(
      `SELECT key FROM ${this.tableName} WHERE key LIKE ?`,
      [`${prefix}%`]
    );
    return rows.map(row => row.key);
  }

  async savePipelineRun(run: PipelineRun): Promise<void> {
    await this.initialize();

    await this.runQuery(
      `INSERT OR REPLACE INTO ${this.runsTableName} 
       (id, pipeline_name, status, started_at, completed_at, trigger_type, trigger_config, error_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.pipelineName,
        run.status,
        run.startedAt.toISOString(),
        run.completedAt?.toISOString(),
        run.trigger.type,
        JSON.stringify(run.trigger.config),
        run.error
      ]
    );

    for (const taskExec of run.tasks) {
      await this.runQuery(
        `INSERT OR REPLACE INTO ${this.tasksTableName} 
         (run_id, task_id, task_name, status, started_at, completed_at, attempts, result_output, result_error, result_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.id,
          taskExec.task.id,
          taskExec.task.name,
          taskExec.status,
          taskExec.startedAt?.toISOString(),
          taskExec.completedAt?.toISOString(),
          taskExec.attempts,
          taskExec.result?.output ? JSON.stringify(taskExec.result.output) : null,
          taskExec.result?.error || null,
          taskExec.result?.metadata ? JSON.stringify(taskExec.result.metadata) : null
        ]
      );
    }
  }

  async getPipelineRun(runId: string): Promise<PipelineRun | null> {
    await this.initialize();

    const runRow = await this.getRow<{
      id: string;
      pipeline_name: string;
      status: string;
      started_at: string;
      completed_at: string | null;
      trigger_type: string;
      trigger_config: string;
      error_text: string | null;
    }>(`SELECT * FROM ${this.runsTableName} WHERE id = ?`, [runId]);

    if (!runRow) return null;

    const taskRows = await this.getAllRows<{
      task_id: string;
      task_name: string;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      attempts: number;
      result_output: string | null;
      result_error: string | null;
      result_metadata: string | null;
    }>(`SELECT * FROM ${this.tasksTableName} WHERE run_id = ?`, [runId]);

    const tasks: TaskExecution[] = taskRows.map(row => ({
      task: {
        id: row.task_id,
        name: row.task_name,
        plugin: '',
        config: {}
      },
      status: row.status as any,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      attempts: row.attempts,
      result: {
        success: row.status === 'success',
        output: row.result_output ? JSON.parse(row.result_output) : undefined,
        error: row.result_error || undefined,
        metadata: row.result_metadata ? JSON.parse(row.result_metadata) : undefined
      }
    }));

    return {
      id: runRow.id,
      pipelineName: runRow.pipeline_name,
      status: runRow.status as any,
      startedAt: new Date(runRow.started_at),
      completedAt: runRow.completed_at ? new Date(runRow.completed_at) : undefined,
      tasks,
      trigger: {
        type: runRow.trigger_type as any,
        config: JSON.parse(runRow.trigger_config)
      },
      error: runRow.error_text || undefined
    };
  }

  async getPipelineRuns(pipelineName: string, limit = 100): Promise<PipelineRun[]> {
    await this.initialize();

    const runRows = await this.getAllRows<{ id: string }>(
      `SELECT id FROM ${this.runsTableName} 
       WHERE pipeline_name = ? 
       ORDER BY started_at DESC 
       LIMIT ?`,
      [pipelineName, limit]
    );

    const runs: PipelineRun[] = [];
    for (const row of runRows) {
      const run = await this.getPipelineRun(row.id);
      if (run) runs.push(run);
    }

    return runs;
  }

  async cleanupOldRuns(retentionDays = 30): Promise<number> {
    await this.initialize();

    const result = await this.getRow<{ count: number }>(
      `SELECT COUNT(*) as count FROM ${this.runsTableName} 
       WHERE started_at < datetime('now', ?)`,
      [`-${retentionDays} days`]
    );

    const count = result?.count || 0;

    if (count > 0) {
      await this.runQuery(
        `DELETE FROM ${this.runsTableName} WHERE started_at < datetime('now', ?)`,
        [`-${retentionDays} days`]
      );
      logger.info(`Cleaned up ${count} pipeline runs older than ${retentionDays} days`);
    }

    return count;
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.db.close((err: Error | null) => { 
        if (err) {
          logger.error('Error closing database', { error: err.message });
        }
        resolve();
      });
    });
  }
}

export function createStateManager(type: 'file' | 'sqlite' = 'file', options?: any): StateManager {
  switch (type) {
    case 'file':
      return new FileStateManager(options);
    case 'sqlite':
      return new SQLiteStateManager(options);
    default:
      throw new PipeJSError(`Unknown state manager type: ${type}`, 'INVALID_STATE_MANAGER');
  }
}

export const stateManager: StateManager = createStateManager();

// Export the StateManager type
export type { StateManager } from '../types.js';