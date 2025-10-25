import { Plugin, PluginConfig, ExecutionContext, ValidationResult, PluginResult } from '../../types.js';
import { sandbox } from '../../utils/sandbox.js';

export interface JSTransformConfig extends PluginConfig {
  code: string;
  data?: unknown;
  timeout?: number;
  context?: Record<string, unknown>;
}

class JSTransformPlugin implements Plugin {
  name = 'js_transform';
  version = '1.0.0';
  description = 'JavaScript transformation plugin for data processing';

  async execute(config: PluginConfig, context: ExecutionContext): Promise<PluginResult> {
    const transformConfig = config as JSTransformConfig;
    const startTime = Date.now();

    try {
      // Validate config
      const validation = this.validate(transformConfig);
      if (!validation.valid) {
        return {
          success: false,
          error: `Config validation failed: ${validation.errors.join(', ')}`
        };
      }

      context.logger.info('Executing JavaScript transformation');

      // Prepare execution context
      const executionContext: Record<string, unknown> = {
        data: transformConfig.data,
        context: transformConfig.context || {},
        pipeline: context.pipeline,
        task: context.task,
        previousResults: Object.fromEntries(context.previousResults),
        state: context.state,
        logger: context.logger
      };

      // Execute the transformation code
      const result = await sandbox.evaluate(
        transformConfig.code,
        executionContext,
        `transform_${context.task.id}`
      );

      const duration = Date.now() - startTime;

      if (result.success) {
        context.logger.info('JavaScript transformation completed successfully', {
          duration,
          task: context.task.id
        });

        return {
          success: true,
          output: result.output,
          metadata: {
            duration,
            timestamp: new Date()
          }
        };
      } else {
        context.logger.error('JavaScript transformation failed', {
          error: result.error,
          duration,
          task: context.task.id
        });

        return {
          success: false,
          error: result.error,
          metadata: {
            duration,
            timestamp: new Date()
          }
        };
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      
      context.logger.error('JavaScript transformation execution failed', {
        error: error instanceof Error ? error.message : String(error),
        duration,
        task: context.task.id
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

  validate(config: PluginConfig): ValidationResult {
    const errors: string[] = [];
    const transformConfig = config as JSTransformConfig;

    if (typeof transformConfig.code !== 'string' || !transformConfig.code.trim()) {
      errors.push('Code is required and must be a non-empty string');
    }

    if (transformConfig.timeout && (typeof transformConfig.timeout !== 'number' || transformConfig.timeout < 0)) {
      errors.push('Timeout must be a non-negative number');
    }

    if (transformConfig.context && typeof transformConfig.context !== 'object') {
      errors.push('Context must be an object');
    }

    // Validate JavaScript syntax if code is provided
    if (transformConfig.code) {
      const syntaxCheck = this.validateJavaScriptSyntax(transformConfig.code);
      if (!syntaxCheck.valid) {
        errors.push(...syntaxCheck.errors);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  private validateJavaScriptSyntax(code: string): ValidationResult {
    try {
      // Basic syntax validation using the sandbox
      const wrappedCode = `(function() { ${code} \n})`;
      new Function(wrappedCode); // This will throw on syntax errors
      return { valid: true, errors: [] };
    } catch (error) {
      return {
        valid: false,
        errors: [`JavaScript syntax error: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  async validateCodeSafety(code: string): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for dangerous patterns
    const dangerousPatterns = [
      { pattern: /\bprocess\.env\b/, message: 'Access to process.env is not allowed' },
      { pattern: /\brequire\s*\(/, message: 'Require statements are not allowed' },
      { pattern: /\bimport\s*\(/, message: 'Dynamic imports are not allowed' },
      { pattern: /\beval\s*\(/, message: 'Eval is not allowed' },
      { pattern: /\bFunction\s*\(/, message: 'Function constructor is not allowed' },
      { pattern: /`/, message: 'Template literals are not allowed for security reasons' },
      { pattern: /\bfs\b/, message: 'File system access is not allowed' },
      { pattern: /\bfetch\b/, message: 'Fetch is not allowed in transform code' }
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(code)) {
        errors.push(message);
      }
    }

    // Check code length
    if (code.length > 10000) {
      warnings.push('Code is very long, consider breaking it into smaller functions');
    }

    // Validate with sandbox
    const sandboxResult = await sandbox.validate(code);
    if (!sandboxResult.valid) {
      errors.push(...sandboxResult.errors);
    }

    return {
      valid: errors.length === 0,
      errors: [...errors, ...warnings] // Treat warnings as errors for strict validation
    };
  }
}

export default new JSTransformPlugin();