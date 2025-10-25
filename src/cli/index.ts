import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRunCommand } from './commands/run.js';
import { createScheduleCommand } from './commands/schedule.js';
import { createValidateCommand } from './commands/validate.js';
import { createVisualizeCommand } from './commands/visualize.js';
import { createLogger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPackageInfo() {
  const possiblePaths = [
    join(__dirname, '../../package.json'), 
    join(__dirname, '../../../package.json'), 
    join(process.cwd(), 'package.json')
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8'));
      } catch (error) {
        console.warn(`Could not read package.json at ${path}:`, error);
      }
    }
  }

  // Fallback if package.json not found
  console.warn('Could not find package.json, using default version');
  return { name: 'pipejs', version: '1.0.0' };
}

const packageInfo = getPackageInfo();

export function createCLI(): Command {
  const program = new Command();

  program
    .name('pipejs')
    .description('A lightweight, extensible pipeline orchestrator for data processing workflows')
    .version(packageInfo.version, '-v, --version', 'Output the current version')
    .hook('preAction', (thisCommand) => {
      const options = thisCommand.opts();
      
      const logLevel = options.silent ? 'error' : options.verbose ? 'debug' : 'info';
      const logFormat = options.json ? 'json' : 'text';
      
      const configuredLogger = createLogger({
        level: logLevel,
        json: options.json,
        colors: !options.json
      });
      
      globalThis.pipejsLogger = configuredLogger;
    })
    .hook('postAction', (thisCommand) => {
      const commandName = thisCommand.name();
      const logger = globalThis.pipejsLogger || createLogger();
      logger.debug(`Command ${commandName} completed`);
    });

  program
    .option('-c, --config <file>', 'Use specified config file for global settings')
    .option('--verbose', 'Enable verbose logging')
    .option('--silent', 'Suppress all output except errors')
    .option('--json', 'Output results as JSON');

  program.addCommand(createRunCommand());
  program.addCommand(createScheduleCommand());
  program.addCommand(createValidateCommand());
  program.addCommand(createVisualizeCommand());

  program.addHelpText('after', `
Examples:
  $ pipejs validate pipeline.yaml
  $ pipejs run pipeline.yaml --verbose
  $ pipejs schedule pipeline.yaml --daemon
  $ pipejs visualize pipeline.yaml --format mermaid

Configuration:
  PipeJS looks for configuration in:
    1. --config option
    2. PIPEJS_CONFIG environment variable
    3. ./pipejs.config.json or ./pipejs.config.yaml
    4. ~/.pipejs/config.json or ~/.pipejs/config.yaml

Documentation:
  For complete documentation, visit: https://pipejs.dev/docs
  `);

  program.showSuggestionAfterError();
  program.configureOutput({
    writeErr: (str) => {
      const logger = globalThis.pipejsLogger || createLogger();
      logger.error(str.trim());
    },
    writeOut: (str) => console.log(str.trim())
  });

  return program;
}

export async function runCLI(argv: string[] = process.argv): Promise<void> {
  const program = createCLI();

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const logger = globalThis.pipejsLogger || createLogger();
    logger.error('CLI execution failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

export { 
  createRunCommand,
  createScheduleCommand, 
  createValidateCommand, 
  createVisualizeCommand 
};

declare global {
  var pipejsLogger: ReturnType<typeof createLogger> | undefined;
}