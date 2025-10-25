import { Plugin, PluginConfig, ExecutionContext, ValidationResult, PluginResult } from '../../types.js';

export interface BigQueryLoadConfig extends PluginConfig {
  projectId: string;
  dataset: string;
  table: string;
  data: unknown[] | string;
  schema?: Record<string, unknown>[];
  writeDisposition?: 'WRITE_APPEND' | 'WRITE_TRUNCATE' | 'WRITE_EMPTY';
  createDisposition?: 'CREATE_IF_NEEDED' | 'CREATE_NEVER';
  authentication: {
    keyFile?: string;
    credentials?: Record<string, unknown>;
  };
}

class BigQueryLoadPlugin implements Plugin {
  name = 'bigquery_load';
  version = '1.0.0';
  description = 'Google BigQuery data loading plugin';

  async execute(config: PluginConfig, context: ExecutionContext): Promise<PluginResult> {
    const bqConfig = config as BigQueryLoadConfig;
    const startTime = Date.now();

    try {
      // Validate config
      const validation = this.validate(bqConfig);
      if (!validation.valid) {
        return {
          success: false,
          error: `Config validation failed: ${validation.errors.join(', ')}`
        };
      }

      context.logger.info('Loading data to BigQuery', {
        project: bqConfig.projectId,
        dataset: bqConfig.dataset,
        table: bqConfig.table
      });

      // In a real implementation, we would use the @google-cloud/bigquery package
      // For this example, we'll simulate the behavior

      // Prepare data
      const data = await this.prepareData(bqConfig.data, context);

      // Simulate BigQuery load operation
      const result = await this.simulateBigQueryLoad(bqConfig, data, context);

      const duration = Date.now() - startTime;

      context.logger.info('BigQuery load completed successfully', {
        project: bqConfig.projectId,
        dataset: bqConfig.dataset,
        table: bqConfig.table,
        rows: data.length,
        duration
      });

      return {
        success: true,
        output: result,
        metadata: {
          duration,
          timestamp: new Date(),
          rowsLoaded: data.length,
          table: `${bqConfig.projectId}.${bqConfig.dataset}.${bqConfig.table}`
        }
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      
      context.logger.error('BigQuery load failed', {
        project: bqConfig.projectId,
        dataset: bqConfig.dataset,
        table: bqConfig.table,
        error: error instanceof Error ? error.message : String(error),
        duration
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          duration,
          timestamp: new Date()
        }
      };
    }
  }

  private async prepareData(data: unknown, context: ExecutionContext): Promise<unknown[]> {
    if (Array.isArray(data)) {
      return data;
    }

    if (typeof data === 'string') {
      try {
        // If data is a string, try to parse it as JSON
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          return parsed;
        }
        throw new Error('Data string must parse to an array');
      } catch (error) {
        context.logger.error('Failed to parse data string as JSON array', {
          error: error instanceof Error ? error.message : String(error)
        });
        throw new Error('Invalid data format: expected array or JSON string of array');
      }
    }

    throw new Error('Data must be an array or JSON string of array');
  }

  private async simulateBigQueryLoad(
    config: BigQueryLoadConfig,
    data: unknown[],
    context: ExecutionContext
  ): Promise<{ jobId: string; rowsProcessed: number }> {
    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

    // Simulate occasional failures
    if (Math.random() < 0.05) { // 5% failure rate for simulation
      throw new Error('Simulated BigQuery API error: Quota exceeded');
    }

    // In a real implementation, this would use the BigQuery client:
    /*
    const bigquery = new BigQuery({
      projectId: config.projectId,
      keyFilename: config.authentication.keyFile,
      credentials: config.authentication.credentials
    });

    const dataset = bigquery.dataset(config.dataset);
    const table = dataset.table(config.table);

    const job = await table.load(data, {
      schema: config.schema,
      writeDisposition: config.writeDisposition,
      createDisposition: config.createDisposition
    });

    return {
      jobId: job[0].jobId,
      rowsProcessed: data.length
    };
    */

    return {
      jobId: `simulated-job-${Date.now()}`,
      rowsProcessed: data.length
    };
  }

  validate(config: PluginConfig): ValidationResult {
    const errors: string[] = [];
    const bqConfig = config as BigQueryLoadConfig;

    // Required fields
    if (typeof bqConfig.projectId !== 'string' || !bqConfig.projectId.trim()) {
      errors.push('Project ID is required and must be a non-empty string');
    }

    if (typeof bqConfig.dataset !== 'string' || !bqConfig.dataset.trim()) {
      errors.push('Dataset is required and must be a non-empty string');
    }

    if (typeof bqConfig.table !== 'string' || !bqConfig.table.trim()) {
      errors.push('Table is required and must be a non-empty string');
    }

    if (!bqConfig.data) {
      errors.push('Data is required');
    }

    // Authentication
    if (!bqConfig.authentication) {
      errors.push('Authentication configuration is required');
    } else {
      if (!bqConfig.authentication.keyFile && !bqConfig.authentication.credentials) {
        errors.push('Either keyFile or credentials must be provided for authentication');
      }

      if (bqConfig.authentication.keyFile && typeof bqConfig.authentication.keyFile !== 'string') {
        errors.push('Key file path must be a string');
      }

      if (bqConfig.authentication.credentials && typeof bqConfig.authentication.credentials !== 'object') {
        errors.push('Credentials must be an object');
      }
    }

    // Optional fields validation
    if (bqConfig.schema && !Array.isArray(bqConfig.schema)) {
      errors.push('Schema must be an array of field definitions');
    }

    const validWriteDispositions = ['WRITE_APPEND', 'WRITE_TRUNCATE', 'WRITE_EMPTY'];
    if (bqConfig.writeDisposition && !validWriteDispositions.includes(bqConfig.writeDisposition)) {
      errors.push(`Write disposition must be one of: ${validWriteDispositions.join(', ')}`);
    }

    const validCreateDispositions = ['CREATE_IF_NEEDED', 'CREATE_NEVER'];
    if (bqConfig.createDisposition && !validCreateDispositions.includes(bqConfig.createDisposition)) {
      errors.push(`Create disposition must be one of: ${validCreateDispositions.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  async validateSchema(schema: unknown[]): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!Array.isArray(schema)) {
      return { valid: false, errors: ['Schema must be an array'] };
    }

    for (const [index, field] of schema.entries()) {
      if (typeof field !== 'object' || field === null) {
        errors.push(`Field at index ${index} must be an object`);
        continue;
      }

      const f = field as Record<string, unknown>;

      if (typeof f.name !== 'string' || !f.name.trim()) {
        errors.push(`Field at index ${index} must have a name`);
      }

      if (typeof f.type !== 'string' || !f.type.trim()) {
        errors.push(`Field at index ${index} must have a type`);
      }

      const validTypes = ['STRING', 'INTEGER', 'FLOAT', 'NUMERIC', 'BOOLEAN', 'TIMESTAMP', 'DATE', 'DATETIME'];
      if (f.type && !validTypes.includes(f.type as string)) {
        errors.push(`Field ${f.name} has invalid type: ${f.type}. Must be one of: ${validTypes.join(', ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default new BigQueryLoadPlugin();