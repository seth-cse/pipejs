// Example PipeJS configuration file
// This file can be placed in your project root or referenced via --config

export default {
  // Global logging configuration
  logging: {
    level: 'info', // debug, info, warn, error
    file: './logs/pipejs.log', // Optional file logging
    json: false, // Structured JSON logging
    colors: true // Colored output
  },

  // State management configuration
  state: {
    type: 'file', // 'file' or 'sqlite'
    file: {
      path: './.pipejs/state.json'
    },
    sqlite: {
      path: './.pipejs/state.db'
    }
  },

  // Plugin configuration
  plugins: {
    builtInPluginsPath: './node_modules/pipejs/dist/plugins/built-in',
    customPluginsPath: './plugins',
    allowCustomPlugins: true,
    validatePlugins: true
  },

  // Execution configuration
  execution: {
    maxConcurrency: 5,
    defaultTimeout: 30000, // 30 seconds
    continueOnError: false
  },

  // Scheduler configuration
  scheduler: {
    timezone: 'UTC',
    maxRetention: 30 // days to keep history
  },

  // Notification configuration
  notifications: {
    default: {
      type: 'console',
      config: {
        level: 'info'
      },
      on: ['failure'] // success, failure, start
    }
  }
};