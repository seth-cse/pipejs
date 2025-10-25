import { readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { 
  Plugin, 
  PluginConfig, 
  ValidationResult, 
  PluginError,
  ExecutionContext 
} from '../types.js';
import { logger } from '../utils/logger.js';
import { sandbox } from '../utils/sandbox.js';

export interface PluginLoaderOptions {
  builtInPluginsPath?: string;
  customPluginsPath?: string;
  allowCustomPlugins?: boolean;
  validatePlugins?: boolean;
}

export interface LoadedPlugin {
  plugin: Plugin;
  source: 'built-in' | 'custom' | 'external';
  path?: string;
}

export class PluginLoader {
  private plugins = new Map<string, LoadedPlugin>();
  private options: Required<PluginLoaderOptions>;
  private isInitialized = false;

  constructor(options: PluginLoaderOptions = {}) {
    this.options = {
      builtInPluginsPath: options.builtInPluginsPath || join(dirname(fileURLToPath(import.meta.url)), 'built-in'),
      customPluginsPath: options.customPluginsPath || join(process.cwd(), 'plugins'),
      allowCustomPlugins: options.allowCustomPlugins ?? true,
      validatePlugins: options.validatePlugins ?? true
    };
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    logger.debug('Initializing plugin loader');

    // Load built-in plugins
    await this.loadBuiltInPlugins();

    // Load custom plugins if enabled
    if (this.options.allowCustomPlugins) {
      await this.loadCustomPlugins();
    }

    this.isInitialized = true;
    logger.info('Plugin loader initialized', { 
      pluginCount: this.plugins.size,
      builtInPath: this.options.builtInPluginsPath,
      customPath: this.options.customPluginsPath
    });
  }

  private async loadBuiltInPlugins(): Promise<void> {
    try {
      const files = await readdir(this.options.builtInPluginsPath);
      
      for (const file of files) {
        if (!file.endsWith('.js') && !file.endsWith('.ts')) continue;

        const pluginName = file.replace(/\.(js|ts)$/, '');
        const pluginPath = join(this.options.builtInPluginsPath, file);

        try {
          // Dynamic import for built-in plugins
          const module = await import(pluginPath);
          const plugin = module.default as Plugin;

          if (this.validatePlugin(plugin, pluginName)) {
            this.plugins.set(pluginName, {
              plugin,
              source: 'built-in',
              path: pluginPath
            });
            logger.debug('Loaded built-in plugin', { plugin: pluginName });
          }
        } catch (error) {
          logger.error('Failed to load built-in plugin', {
            plugin: pluginName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      logger.error('Failed to load built-in plugins', {
        path: this.options.builtInPluginsPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async loadCustomPlugins(): Promise<void> {
    try {
      const stats = await stat(this.options.customPluginsPath).catch(() => null);
      if (!stats?.isDirectory()) {
        logger.debug('Custom plugins directory does not exist', {
          path: this.options.customPluginsPath
        });
        return;
      }

      const files = await readdir(this.options.customPluginsPath);
      
      for (const file of files) {
        if (!file.endsWith('.js')) continue;

        const pluginName = file.replace(/\.js$/, '');
        const pluginPath = join(this.options.customPluginsPath, file);

        try {
          // Dynamic import for custom plugins
          const module = await import(pluginPath);
          const plugin = module.default as Plugin;

          if (this.validatePlugin(plugin, pluginName)) {
            this.plugins.set(pluginName, {
              plugin,
              source: 'custom',
              path: pluginPath
            });
            logger.debug('Loaded custom plugin', { plugin: pluginName });
          }
        } catch (error) {
          logger.error('Failed to load custom plugin', {
            plugin: pluginName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      logger.error('Failed to load custom plugins', {
        path: this.options.customPluginsPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private validatePlugin(plugin: unknown, name: string): plugin is Plugin {
    if (typeof plugin !== 'object' || plugin === null) {
      logger.error('Plugin must be an object', { plugin: name });
      return false;
    }

    const p = plugin as Record<string, unknown>;

    // Validate required fields
    if (typeof p.name !== 'string') {
      logger.error('Plugin must have a name', { plugin: name });
      return false;
    }

    if (typeof p.version !== 'string') {
      logger.error('Plugin must have a version', { plugin: name });
      return false;
    }

    if (typeof p.execute !== 'function') {
      logger.error('Plugin must have an execute function', { plugin: name });
      return false;
    }

    // Validate execute function signature
    const execute = p.execute;
    if (execute.length < 2) {
      logger.error('Plugin execute function must accept config and context parameters', { plugin: name });
      return false;
    }

    // Validate optional validate function
    if (p.validate && typeof p.validate !== 'function') {
      logger.error('Plugin validate must be a function', { plugin: name });
      return false;
    }

    logger.debug('Plugin validation passed', { plugin: name });
    return true;
  }

  async loadPlugin(name: string): Promise<Plugin | null> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const loaded = this.plugins.get(name);
    if (loaded) {
      return loaded.plugin;
    }

    logger.warn('Plugin not found', { plugin: name });
    return null;
  }

  async loadExternalPlugin(code: string, name: string, version = '1.0.0'): Promise<Plugin> {
    const pluginId = `external:${name}`;

    try {
      // Evaluate the plugin code in a sandbox
      const result = await sandbox.evaluate(code, {}, pluginId);

      if (!result.success) {
        throw new PluginError(`Failed to evaluate plugin: ${result.error}`, {
          plugin: name,
          error: result.error
        });
      }

      const plugin: Plugin = {
        name,
        version,
        execute: result.output as Plugin['execute']
      };

      if (this.validatePlugin(plugin, name)) {
        this.plugins.set(pluginId, {
          plugin,
          source: 'external'
        });

        logger.debug('Loaded external plugin', { plugin: name });
        return plugin;
      } else {
        throw new PluginError('External plugin validation failed', { plugin: name });
      }
    } catch (error) {
      if (error instanceof PluginError) {
        throw error;
      }
      throw new PluginError(
        `Failed to load external plugin: ${error instanceof Error ? error.message : String(error)}`,
        { plugin: name }
      );
    }
  }

  async validatePluginConfig(pluginName: string, config: PluginConfig): Promise<ValidationResult> {
    const plugin = await this.loadPlugin(pluginName);
    if (!plugin) {
      return {
        valid: false,
        errors: [`Plugin not found: ${pluginName}`]
      };
    }

    if (plugin.validate) {
      return plugin.validate(config);
    }

    // Default validation for common config patterns
    return this.defaultConfigValidation(config, pluginName);
  }

  private defaultConfigValidation(config: PluginConfig, pluginName: string): ValidationResult {
    const errors: string[] = [];

    if (typeof config !== 'object' || config === null) {
      errors.push('Config must be an object');
      return { valid: false, errors };
    }

    // Plugin-specific validation can be added here based on pluginName
    // For now, just do basic object validation

    return {
      valid: errors.length === 0,
      errors
    };
  }

  getLoadedPlugins(): Map<string, LoadedPlugin> {
    return new Map(this.plugins);
  }

  listPlugins(): { name: string; version: string; source: string }[] {
    return Array.from(this.plugins.entries()).map(([name, loaded]) => ({
      name,
      version: loaded.plugin.version,
      source: loaded.source
    }));
  }

  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  unloadPlugin(name: string): boolean {
    return this.plugins.delete(name);
  }

  clearPlugins(): void {
    this.plugins.clear();
    this.isInitialized = false;
  }
}

// Default plugin loader instance
export const pluginLoader = new PluginLoader();