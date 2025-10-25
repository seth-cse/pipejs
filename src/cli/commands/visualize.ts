import { Command } from 'commander';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { VisualizeCommandOptions, ValidationError } from '../../types.js';
import { parser } from '../../core/parser.js';
import { mermaid } from '../../utils/mermaid.js';
import { logger, createLogger } from '../../utils/logger.js';

export function createVisualizeCommand(): Command {
  const command = new Command('visualize')
    .description('Generate visualization for a pipeline')
    .argument('<config-file>', 'Path to pipeline configuration file (YAML or JSON)')
    .option('-o, --output <file>', 'Output file path (default: stdout)')
    .option('-f, --format <format>', 'Output format: mermaid, svg, png', 'mermaid')
    .option('-t, --theme <theme>', 'Diagram theme: default, dark, neutral', 'default')
    .option('-j, --json', 'Output results as JSON', false)
    .option('-v, --verbose', 'Enable verbose output', false)
    .action(async (configFile: string, options: VisualizeCommandOptions) => {
      await handleVisualizeCommand(configFile, options);
    });

  return command;
}

async function handleVisualizeCommand(configFile: string, options: VisualizeCommandOptions): Promise<void> {
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

    commandLogger.info('Generating pipeline visualization', { file: resolvedPath });

    // Parse pipeline configuration
    const parseResult = await parser.parseFile(resolvedPath);
    
    if (parseResult.errors.length > 0) {
      throw new ValidationError(
        `Pipeline configuration validation failed:\n${parseResult.errors.join('\n')}`,
        { errors: parseResult.errors }
      );
    }

    const pipeline = parseResult.pipeline;
    commandLogger.info('Pipeline loaded successfully', { 
      pipeline: pipeline.name, 
      taskCount: pipeline.tasks.length 
    });

    // Generate visualization
    const visualizationOptions = {
      theme: options.theme as any,
      orientation: 'TB' as const,
      showDescriptions: true,
      showStatus: false
    };

    const result = mermaid.generate(pipeline, undefined, visualizationOptions);

    if (result.errors.length > 0) {
      commandLogger.warn('Visualization generation warnings', { errors: result.errors });
    }

    await outputVisualization(result, pipeline, options, commandLogger, startTime);

    commandLogger.info('Visualization generated successfully', { 
      duration: Date.now() - startTime,
      format: options.format 
    });

  } catch (error) {
    await handleVisualizationError(error, options, commandLogger, startTime);
    process.exit(1);
  }
}

async function outputVisualization(
  result: any,
  pipeline: any,
  options: VisualizeCommandOptions,
  commandLogger: typeof logger,
  startTime: number
): Promise<void> {
  const outputData = {
    pipeline: pipeline.name,
    version: pipeline.version,
    format: options.format,
    mermaid: result.mermaid,
    errors: result.errors,
    duration: Date.now() - startTime,
    timestamp: new Date().toISOString()
  };

  if (options.json) {
    const output = JSON.stringify(outputData, null, 2);
    if (options.output) {
      ensureDirectoryExists(options.output);
      writeFileSync(options.output, output);
    } else {
      console.log(output);
    }
    return;
  }

  // Handle different output formats
  switch (options.format) {
    case 'mermaid':
      if (options.output) {
        ensureDirectoryExists(options.output);
        writeFileSync(options.output, result.mermaid);
        commandLogger.info(`Mermaid diagram written to: ${options.output}`);
      } else {
        console.log(result.mermaid);
      }
      break;

    case 'svg':
    case 'png':
      await generateImageOutput(result.mermaid, options, commandLogger);
      break;

    default:
      throw new ValidationError(`Unsupported format: ${options.format}. Supported formats: mermaid, svg, png`);
  }

  if (result.errors.length > 0 && options.verbose) {
    commandLogger.warn('Visualization generation encountered issues:', {
      errors: result.errors
    });
  }
}

async function generateImageOutput(
  mermaidCode: string,
  options: VisualizeCommandOptions,
  commandLogger: typeof logger
): Promise<void> {
  // In a real implementation, we would use mermaid-cli or a similar tool
  // to convert Mermaid to SVG/PNG. For this example, we'll provide guidance.
  
  commandLogger.warn('SVG and PNG generation requires mermaid-cli to be installed');
  commandLogger.info('To generate images, install mermaid-cli and use:');
  commandLogger.info('npx @mermaid-js/mermaid-cli -i input.mmd -o output.' + options.format);
  
  // Write Mermaid code to temporary file for user convenience
  if (options.output) {
    const mmdPath = options.output.replace(/\.(svg|png)$/, '.mmd');
    ensureDirectoryExists(mmdPath);
    writeFileSync(mmdPath, mermaidCode);
    commandLogger.info(`Mermaid source written to: ${mmdPath}`);
    commandLogger.info(`Run: npx @mermaid-js/mermaid-cli -i ${mmdPath} -o ${options.output}`);
  } else {
    // If no output file specified for image format, fall back to mermaid output
    commandLogger.info('Falling back to Mermaid output format');
    console.log(mermaidCode);
  }
}

function ensureDirectoryExists(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function handleVisualizationError(
  error: unknown,
  options: VisualizeCommandOptions,
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
    console.error(JSON.stringify(errorOutput, null, 2));
  } else {
    commandLogger.error('Visualization generation failed', {
      error: error instanceof Error ? error.message : String(error),
      duration: `${duration}ms`
    });

    if (error instanceof ValidationError && error.context) {
      commandLogger.error('Validation details:', error.context);
    }
  }
}