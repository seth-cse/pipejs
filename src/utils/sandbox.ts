import { VM, VMScript } from 'vm2';
import { PluginError } from '../types.js';

export interface SandboxOptions {
  timeout?: number;
  sandbox?: Record<string, unknown>;
  extensions?: {
    require?: boolean;
    rootPath?: string;
  };
}

export interface EvalResult {
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
}

export class SafeJSEvaluator {
  private vm: VM;
  private scriptCache = new Map<string, VMScript>();

  constructor(options: SandboxOptions = {}) {
    const defaultSandbox = {
      console: {
        log: (...args: unknown[]) => console.log('[SANDBOX]', ...args),
        error: (...args: unknown[]) => console.error('[SANDBOX]', ...args),
        warn: (...args: unknown[]) => console.warn('[SANDBOX]', ...args),
        info: (...args: unknown[]) => console.info('[SANDBOX]', ...args)
      },
      Date,
      Math,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      TypeError,
      RangeError,
      ReferenceError,
      SyntaxError
    };

    this.vm = new VM({
      timeout: options.timeout || 5000,
      sandbox: { ...defaultSandbox, ...options.sandbox },
      eval: false,
      wasm: false,
      fixAsync: true
    });
  }

  private compileScript(code: string, identifier: string): VMScript {
    const cacheKey = `${identifier}:${Buffer.from(code).toString('base64')}`;
    
    if (this.scriptCache.has(cacheKey)) {
      return this.scriptCache.get(cacheKey)!;
    }

    try {
      // Wrap in IIFE to capture return value and prevent global leakage
      const wrappedCode = `
        (function() {
          "use strict";
          const exports = {};
          const module = { exports };
          const require = undefined; // Disable require unless explicitly allowed
          
          // User code execution
          const result = (function() {
            ${code}
          })();
          
          return typeof result === 'undefined' ? module.exports : result;
        })()
      `;

      const script = new VMScript(wrappedCode, identifier);
      this.scriptCache.set(cacheKey, script);
      return script;
    } catch (error) {
      throw new PluginError(
        `Failed to compile script: ${error instanceof Error ? error.message : String(error)}`,
        { identifier, code: code.substring(0, 100) + '...' }
      );
    }
  }

  async evaluate(code: string, context: Record<string, unknown> = {}, identifier = 'anonymous'): Promise<EvalResult> {
    const startTime = Date.now();

    try {
      const script = this.compileScript(code, identifier);
      
      // Add context to sandbox for this execution only
      const executionSandbox = { ...context };
      Object.keys(executionSandbox).forEach(key => {
        this.vm.freeze(executionSandbox[key], key);
      });

      const output = this.vm.run(script);

      return {
        success: true,
        output,
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        success: false,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
    }
  }

  async validate(code: string): Promise<{ valid: boolean; errors: string[] }> {
    try {
      new VMScript(code, 'validation');
      return { valid: true, errors: [] };
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  clearCache(): void {
    this.scriptCache.clear();
  }

  dispose(): void {
    this.clearCache();
    // VM2 doesn't have explicit dispose, but we can help GC
    (this.vm as any) = null;
  }
}

// Default evaluator instance
export const sandbox = new SafeJSEvaluator();

// Factory function for creating evaluators with specific contexts
export function createEvaluator(context: Record<string, unknown>, options: SandboxOptions = {}): SafeJSEvaluator {
  return new SafeJSEvaluator({
    ...options,
    sandbox: context
  });
}