import { Plugin, PluginConfig, ExecutionContext, ValidationResult, PluginResult } from '../../types.js';

export interface HTTPGetConfig extends PluginConfig {
  url: string;
  headers?: Record<string, string>;
  timeout?: number;
  retry?: {
    attempts: number;
    delay: number;
  };
  validateSSL?: boolean;
}

class HTTPGetPlugin implements Plugin {
  name = 'http_get';
  version = '1.0.0';
  description = 'HTTP GET request plugin';

  async execute(config: PluginConfig, context: ExecutionContext): Promise<PluginResult> {
    const httpConfig = config as HTTPGetConfig;
    const startTime = Date.now();

    try {
      // Validate config
      const validation = this.validate(httpConfig);
      if (!validation.valid) {
        return {
          success: false,
          error: `Config validation failed: ${validation.errors.join(', ')}`
        };
      }

      context.logger.info('Making HTTP GET request', { url: httpConfig.url });

      const controller = new AbortController();
      const timeout = httpConfig.timeout || 30000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(httpConfig.url, {
          method: 'GET',
          headers: httpConfig.headers,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.text();
        const contentType = response.headers.get('content-type') || '';

        let output: unknown = data;
        
        // Parse JSON if content-type indicates
        if (contentType.includes('application/json')) {
          try {
            output = JSON.parse(data);
          } catch (parseError) {
            context.logger.warn('Failed to parse JSON response, returning raw text', {
              error: parseError instanceof Error ? parseError.message : String(parseError)
            });
          }
        }

        const duration = Date.now() - startTime;

        context.logger.info('HTTP GET request successful', {
          url: httpConfig.url,
          status: response.status,
          duration,
          size: data.length
        });

        return {
          success: true,
          output,
          metadata: {
            duration,
            timestamp: new Date(),
            statusCode: response.status,
            contentType,
            headers: Object.fromEntries(response.headers.entries())
          }
        };

      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }

    } catch (error) {
      const duration = Date.now() - startTime;
      
      context.logger.error('HTTP GET request failed', {
        url: httpConfig.url,
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

  validate(config: PluginConfig): ValidationResult {
    const errors: string[] = [];
    const httpConfig = config as HTTPGetConfig;

    if (typeof httpConfig.url !== 'string' || !httpConfig.url.trim()) {
      errors.push('URL is required and must be a non-empty string');
    } else {
      try {
        new URL(httpConfig.url);
      } catch {
        errors.push('URL must be a valid URL');
      }
    }

    if (httpConfig.headers && typeof httpConfig.headers !== 'object') {
      errors.push('Headers must be an object');
    }

    if (httpConfig.timeout && (typeof httpConfig.timeout !== 'number' || httpConfig.timeout < 0)) {
      errors.push('Timeout must be a non-negative number');
    }

    if (httpConfig.retry) {
      if (typeof httpConfig.retry.attempts !== 'number' || httpConfig.retry.attempts < 0) {
        errors.push('Retry attempts must be a non-negative number');
      }
      if (typeof httpConfig.retry.delay !== 'number' || httpConfig.retry.delay < 0) {
        errors.push('Retry delay must be a non-negative number');
      }
    }

    if (httpConfig.validateSSL !== undefined && typeof httpConfig.validateSSL !== 'boolean') {
      errors.push('validateSSL must be a boolean');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default new HTTPGetPlugin();