import pino, { Logger, LoggerOptions } from 'pino';

const pinoOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      '*.apiKey',
      '*.api_key',
      '*.password',
      '*.token',
      '*.secret',
      'LOCATION_API_KEY',
      'apiKey',
      'api_key'
    ],
    censor: '[REDACTED]'
  },
  base: {
    service: 'geonames-pipeline'
  }
};

export const rootLogger: Logger = pino(pinoOptions);

export function createLogger(context?: Record<string, unknown>): Logger {
  if (!context) {
    return rootLogger;
  }
  return rootLogger.child(context);
}

export default rootLogger;
