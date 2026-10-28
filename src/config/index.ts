import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import type { PipelineConfig } from '../types.js';

// Load .env if present
dotenv.config();

const rawEnvSchema = z.object({
  LOCATION_API_KEY: z.string().optional().default(''),
  LOCATION_API_BASE_URL: z.string().default('https://maps.googleapis.com/maps/api'),
  LOCATION_CACHE_TTL_DAYS: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 30))
    .pipe(z.number().positive()),
  LOCATION_DATA_DIR: z.string().default('./data/locations'),
  LOCATION_DOWNLOADS_DIR: z.string().default('./data/downloads'),
  LOCATION_BATCH_SIZE: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 5000))
    .pipe(z.number().positive()),
  LOCATION_CONCURRENCY: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 2))
    .pipe(z.number().positive()),
  LOCATION_CRON_SCHEDULE: z.string().default('0 3 * * 0'),
  LOCATION_COUNTRY_CODES: z
    .string()
    .default('IN,US,GB,CA,AU,DE,FR,JP,BR,CN')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    ),
  LOCATION_FEATURE_CLASSES: z
    .string()
    .default('P,A')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    ),
  LOCATION_MIN_POPULATION: z
    .string()
    .optional()
    .transform((val) => (val !== undefined && val !== '' ? parseInt(val, 10) : 0))
    .pipe(z.number().min(0)),
  GEONAMES_BASE_URL: z
    .string()
    .url()
    .default('https://download.geonames.org/export/dump/'),
  DOWNLOAD_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 300000))
    .pipe(z.number().positive()),
  DOWNLOAD_MAX_RETRIES: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 3))
    .pipe(z.number().min(0))
});

export function parseConfig(envInput: Record<string, string | undefined>): PipelineConfig {
  const parsed = rawEnvSchema.parse(envInput);
  const dataDir = path.resolve(process.cwd(), parsed.LOCATION_DATA_DIR);
  const downloadsDir = path.resolve(process.cwd(), parsed.LOCATION_DOWNLOADS_DIR);

  return {
    apiKey: (parsed.LOCATION_API_KEY || '').trim(),
    apiBaseUrl: parsed.LOCATION_API_BASE_URL.replace(/\/+$/, ''),
    cacheTtlDays: parsed.LOCATION_CACHE_TTL_DAYS,
    dataDir,
    downloadsDir,
    batchSize: parsed.LOCATION_BATCH_SIZE,
    concurrency: parsed.LOCATION_CONCURRENCY,
    cronSchedule: parsed.LOCATION_CRON_SCHEDULE,
    countryCodes: parsed.LOCATION_COUNTRY_CODES,
    featureClasses: parsed.LOCATION_FEATURE_CLASSES,
    minPopulation: parsed.LOCATION_MIN_POPULATION,
    baseUrl: parsed.GEONAMES_BASE_URL.endsWith('/')
      ? parsed.GEONAMES_BASE_URL
      : `${parsed.GEONAMES_BASE_URL}/`,
    timeoutMs: parsed.DOWNLOAD_TIMEOUT_MS,
    maxRetries: parsed.DOWNLOAD_MAX_RETRIES
  };
}

export function loadConfig(envOverrides?: Record<string, string | undefined>): PipelineConfig {
  const mergedEnv = {
    ...process.env,
    ...envOverrides
  };
  return parseConfig(mergedEnv);
}

export const config: PipelineConfig = loadConfig();
export default config;
