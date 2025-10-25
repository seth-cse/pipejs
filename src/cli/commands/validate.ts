import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { ValidateCommandOptions, ValidationError } from '../../types.js';
import { parser } from '../../core/parser.js';
import { pluginLoader } from '../../plugins/loader.js';
import { logger, createLogger } from '../../utils/logger.js';

export function createValidateCommand(): Command {
  const command = new Command('validate')
    .description('Validate a pipeline configuration file')
    .argument('<config-file>', 'Path to pipeline configuration file (YAML or JSON)')
    .option('-s, --strict', 'Treat warnings as errors', false)
    .option('-v, --verbose', 'Enable verbose output', false)
    .option('-j, --json', 'Output results as JSON', false)
    .option('-o, --output <file>', 'Write output to file instead of stdout')
    .action(async (configFile: string, options: ValidateCommandOptions) => {
      await handleValidateCommand(configFile, options);
    });

  return command;
}

async function handleValidateCommand(configFile: string, options: ValidateCommandOptions): Promise<void> {
  const startTime = Date.now();

  // Configure logger based on options
  const logLevel = options.verbose ? 'debug' : 'info';
  const commandLogger = createLogger({
    level: logLevel,
    json: options.json,
    colors: !options.json
  });

  try {
    // Resolve and validate config file path
    const resolvedPath = resolve(configFile);
    if (!existsSync(resolvedPath)) {
      throw new ValidationError(`Configuration file not found: ${resolvedPath}`);
    }

    commandLogger.info('Validating pipeline configuration', { file: resolvedPath });

    // Read file for syntax checking
    const fileContent = readFileSync(resolvedPath, 'utf-8');
    
    // Basic syntax validation
    const syntaxResult = validateSyntax(fileContent, resolvedPath);
    if (!syntaxResult.valid) {
      throw new ValidationError(
        `Configuration file syntax error: ${syntaxResult.error}`,
        { file: resolvedPath, error: syntaxResult.error }
      );
    }

    // Parse and validate pipeline
    const parseResult = await parser.parseFile(resolvedPath);
    const pipeline = parseResult.pipeline;

    // Validate plugins
    const pluginValidation = await validatePlugins(pipeline, commandLogger);

    const validationResult = {
      valid: parseResult.errors.length === 0 && pluginValidation.missingPlugins.length === 0,
      errors: parseResult.errors,
      warnings: parseResult.warnings,
      pluginErrors: pluginValidation.missingPlugins,
      pipeline: {
        name: pipeline.name,
        version: pipeline.version,
        taskCount: pipeline.tasks.length,
        triggerCount: pipeline.triggers?.length || 0
      },
      duration: Date.now() - startTime,
      file: resolvedPath
    };

    // Apply strict mode
    if (options.strict && validationResult.warnings.length > 0) {
      validationResult.valid = false;
      validationResult.errors.push(...validationResult.warnings.map(w => `[STRICT] ${w}`));
    }

    await outputValidationResult(validationResult, options, commandLogger);

    if (!validationResult.valid) {
      process.exit(1);
    }

  } catch (error) {
    await handleValidationError(error, options, commandLogger, startTime);
    process.exit(1);
  }
}

function validateSyntax(content: string, filePath: string): { valid: boolean; error?: string } {
  try {
    if (content.trim().startsWith('{')) {
      JSON.parse(content);
    } else {
      // For now, it is a basic YAML check without js-yaml
      // This avoids the dynamic import issue
      if (content.includes('---') || content.includes(': ') || content.includes('- ')) {
        // Basic YAML structure detected - we'll assume it's valid for now
        return { valid: true };
      }
      return { valid: false, error: 'Invalid YAML structure' };
    }
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function validatePlugins(pipeline: any, commandLogger: typeof logger): Promise<{ missingPlugins: string[] }> {
  const missingPlugins: string[] = [];

  for (const task of pipeline.tasks) {
    if (!task.enabled) continue;

    const plugin = await pluginLoader.loadPlugin(task.plugin);
    if (!plugin) {
      missingPlugins.push(`${task.id} (${task.plugin})`);
    } else {
      // Validate task-specific configuration
      if (plugin.validate) {
        const validation = plugin.validate(task.config);
        if (!validation.valid) {
          missingPlugins.push(`${task.id}: ${validation.errors.join(', ')}`);
        }
      }
    }
  }

  if (missingPlugins.length > 0) {
    commandLogger.debug('Plugin validation failed', { missingPlugins });
  }

  return { missingPlugins };
}

async function outputValidationResult(
  result: any,
  options: ValidateCommandOptions,
  commandLogger: typeof logger
): Promise<void> {
  if (options.json) {
    const output = JSON.stringify(result, null, 2);
    if (options.output) {
      const fs = await import('fs');
      fs.writeFileSync(options.output, output);
    } else {
      console.log(output);
    }
  } else {
    if (result.valid) {
      commandLogger.info('✅ Pipeline configuration is valid', {
        pipeline: result.pipeline.name,
        version: result.pipeline.version,
        tasks: result.pipeline.taskCount,
        triggers: result.pipeline.triggerCount,
        duration: `${result.duration}ms`
      });

      if (result.warnings.length > 0) {
        commandLogger.warn('Configuration warnings (non-fatal):');
        result.warnings.forEach((warning: string, index: number) => {
          console.log(`  ${index + 1}. ${warning}`);
        });
      }
    } else {
      commandLogger.error('❌ Pipeline configuration validation failed');

      if (result.errors.length > 0) {
        console.log('\nErrors:');
        result.errors.forEach((error: string, index: number) => {
          console.log(`  ${index + 1}. ${error}`);
        });
      }

      if (result.pluginErrors.length > 0) {
        console.log('\nPlugin errors:');
        result.pluginErrors.forEach((error: string, index: number) => {
          console.log(`  ${index + 1}. ${error}`);
        });
      }

      if (result.warnings.length > 0) {
        console.log('\nWarnings:');
        result.warnings.forEach((warning: string, index: number) => {
          console.log(`  ${index + 1}. ${warning}`);
        });
      }
    }

    if (options.verbose) {
      commandLogger.debug('Detailed validation results:', {
        file: result.file,
        duration: result.duration
      });
    }
  }
}

async function handleValidationError(
  error: unknown,
  options: ValidateCommandOptions,
  commandLogger: typeof logger,
  startTime: number
): Promise<void> {
  const duration = Date.now() - startTime;

  if (options.json) {
    const errorOutput = {
      valid: false,
      error: true,
      message: error instanceof Error ? error.message : String(error),
      duration,
      timestamp: new Date().toISOString()
    };
    console.error(JSON.stringify(errorOutput, null, 2));
  } else {
    commandLogger.error('Validation failed', {
      error: error instanceof Error ? error.message : String(error),
      duration: `${duration}ms`
    });

    if (error instanceof ValidationError && error.context) {
      commandLogger.error('Validation context:', error.context);
    }
  }
}