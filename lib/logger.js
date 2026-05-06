'use strict';

const pino = require('pino');
const { parseAppConfig } = require('./config');

const appConfig = parseAppConfig(process.env);

const transport = appConfig.logPretty
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: process.stdout.isTTY,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname'
      }
    })
  : undefined;

const logger = pino(
  {
    level: appConfig.logLevel,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      }
    }
  },
  transport
);

function childLogger(bindings = {}) {
  return logger.child(bindings);
}

module.exports = {
  logger,
  childLogger
};
