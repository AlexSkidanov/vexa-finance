import { pino, type DestinationStream, type Logger } from 'pino';

/**
 * Structured JSON logs. The redaction list is a safety net for the rule that
 * matters most here: no plaintext amount, key, token or secret ever reaches a
 * log line. Code shouldn't log these in the first place. This catches the day
 * someone logs a whole request body by accident.
 */
const REDACT_PATHS = [
  'amount',
  '*.amount',
  '*.*.amount',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.token',
  '*.secret',
  '*.password',
  '*.privateKey',
  '*.secretKey',
  '*.seed',
  '*.apiKey',
];

export function createLogger(
  level: string,
  pretty = false,
  destination?: DestinationStream,
): Logger {
  const options = {
    level,
    base: { service: 'vexa-api' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty && !destination
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
