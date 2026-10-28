/**
 * Types and interfaces for the Location Ingestion & JSON Caching System.
 */

export interface RawGeoNameRecord {
  geonameid: string;
  name: string;
  asciiname: string;
  alternatenames: string[];
  latitude: string;
  longitude: string;
  featureClass: string;
  featureCode: string;
  countryCode: string;
  cc2: string[];
  admin1Code: string;
  admin2Code: string;
  admin3Code: string;
  admin4Code: string;
  population: string;
  elevation: string;
  dem: string;
  timezone: string;
  modificationDate: string;
  lineNumber: number;
}

export interface LocationRecord {
  id: string;                  // Stable provider identifier (e.g. Google place_id or geonameid)
  name: string;                // Primary UTF-8 location / city name
  asciiName: string;           // Transliterated ASCII name
  alternateNames?: string[];   // Alternate/colloquial/local names (e.g. Bombay for Mumbai, NYC for New York)
  countryCode: string;         // ISO 3166-1 alpha-2 code (e.g. IN, US)
  countryName: string;         // Canonical country name
  admin1Code: string | null;   // Primary administrative division code (state/province)
  admin1Name: string | null;   // Primary administrative division name
  admin2Code: string | null;   // Secondary division (district/county)
  featureClass: string | null; // e.g. 'P' or 'A' for GeoNames; null for Google Maps
  featureCode: string | null;  // e.g. 'PPL' for GeoNames; null for Google Maps
  types?: string[];            // Provider raw types (e.g. ['locality', 'political'] from Google)
  latitude: number;            // WGS 84 latitude [-90, 90]
  longitude: number;           // WGS 84 longitude [-180, 180]
  timezone: string | null;     // IANA timezone identifier (e.g. Asia/Kolkata)
  population: number | null;   // Permanent population count if available, else null
  elevation: number | null;    // Elevation in meters if available, else null
  modificationDate: string | null; // Provider modification date if available, else null
  source: 'google-maps' | 'geonames' | string;
  updatedAt: string;           // ISO-8601 timestamp of retrieval/caching
}

export type CacheLookupStatus =
  | 'HIT'
  | 'MISS'
  | 'EXPIRED'
  | 'VALID_EMPTY'
  | 'API_FAILURE'
  | 'RATE_LIMITED';

export interface CacheLookupResult {
  status: CacheLookupStatus;
  record: LocationRecord | null;
  fromCache: boolean;
  refreshed: boolean;
  error?: string;
  cacheKey: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ValidationStats {
  passed: number;
  failed: number;
  errorsByType: Record<string, number>;
}

export type RunMode = 'full' | 'incremental' | 'country' | 'seed' | 'refresh' | 'global';
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface CountryCheckpoint {
  lastProcessedLine: number;
  recordCount: number;
  timestamp: string;
}

export interface RunState {
  runId: string;
  mode: RunMode;
  startedAt: string;
  completedAt: string | null;
  status: RunStatus;
  currentCountry: string | null;
  processedRecords: number;
  insertedRecords: number;
  skippedRecords: number;
  failedRecords: number;
  apiRequestsCount: number;
  countriesCompleted: string[];
  countriesRemaining: string[];
  lastError: string | null;
  lastSuccessfulRun: string | null;
  checkpoints: Record<string, CountryCheckpoint>;
}

export interface CountryCoverage {
  code: string;
  name: string;
  recordCount: number;
}

export interface PipelineManifest {
  schemaVersion: string;
  generatedAt: string;
  source: 'google-maps' | 'geonames' | string;
  license?: string;
  attribution?: string;
  totalRecords: number;
  countryCoverage: CountryCoverage[];
  status: 'completed' | 'in_progress' | 'failed';
  checksums: Record<string, string>;
}

export interface PipelineConfig {
  apiKey: string;
  apiBaseUrl: string;
  dataDir: string;
  downloadsDir: string;
  batchSize: number;
  concurrency: number;
  cronSchedule: string;
  cacheTtlDays: number;
  countryCodes: string[];
  featureClasses: string[];
  minPopulation: number;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface LockInfo {
  pid: number;
  startedAt: string;
  runId: string;
}
