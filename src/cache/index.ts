import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import type { CacheLookupResult, LocationRecord } from '../types.js';
import { GoogleMapsApiClient, defaultApiClient } from '../apiClient/index.js';
import { LocationExporter } from '../exporter/index.js';
import { LocalGeoNamesResolver } from './localResolver.js';

const logger = createLogger({ module: 'cache' });

export interface CacheStats {
  hits: number;
  misses: number;
  expiredHits: number;
  refreshes: number;
  failures: number;
  totalCached: number;
}

export class LocationCacheService {
  private apiClient: GoogleMapsApiClient;
  private exporter: LocationExporter;
  private localResolver: LocalGeoNamesResolver;
  private cacheTtlDays: number;

  // In-memory negative cache: cacheKey -> timestamp (ms)
  // Compliant in-memory caching for zero-result lookups avoids repeated Google API billing
  // without creating persistent synthetic records on disk or violating Google Maps Platform terms.
  private negativeCache = new Map<string, number>();
  private negativeCacheTtlMs: number;

  // In-memory index of normalizedKey -> LocationRecord
  private cacheIndex = new Map<string, LocationRecord>();
  // In-memory index of id -> LocationRecord
  private idIndex = new Map<string, LocationRecord>();

  // In-flight request coalescing (singleflight) map: cacheKey -> Promise<CacheLookupResult>
  private inFlightRequests = new Map<string, Promise<CacheLookupResult>>();

  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    expiredHits: 0,
    refreshes: 0,
    failures: 0,
    totalCached: 0
  };

  private isInitialized = false;

  constructor(options?: {
    apiClient?: GoogleMapsApiClient;
    exporter?: LocationExporter;
    cacheTtlDays?: number;
    negativeCacheTtlHours?: number;
    localResolver?: LocalGeoNamesResolver;
  }) {
    this.apiClient = options?.apiClient ?? defaultApiClient;
    this.exporter = options?.exporter ?? new LocationExporter(config.dataDir);
    this.cacheTtlDays = options?.cacheTtlDays ?? config.cacheTtlDays;
    this.negativeCacheTtlMs = (options?.negativeCacheTtlHours ?? 24) * 60 * 60 * 1000;
    this.localResolver =
      options?.localResolver ?? new LocalGeoNamesResolver({ dataDir: this.exporter.getDataDir() });
  }

  /**
   * Builds the cache key from country code and city name.
   */
  public static buildCacheKey(cityName: string, countryCode?: string): string {
    const normCity = cityName.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const normCountry = (countryCode || '').trim().toUpperCase();
    return normCountry ? `${normCountry}:${normCity}` : normCity;
  }

  /**
   * Initializes cache by scanning and indexing existing JSON files on disk.
   */
  public async initCache(): Promise<number> {
    if (this.isInitialized) {
      return this.cacheIndex.size;
    }

    const countriesDir = this.exporter.getCountriesDir();
    if (!fs.existsSync(countriesDir)) {
      this.isInitialized = true;
      return 0;
    }

    const files = fs.readdirSync(countriesDir).filter((f) => f.endsWith('.json'));
    let loadedCount = 0;

    for (const file of files) {
      let countryCode: string;
      const filePath = path.join(countriesDir, file);

      if (file.endsWith('.cache.json')) {
        countryCode = file.replace(/\.cache\.json$/i, '').toUpperCase();
      } else {
        countryCode = path.basename(file, '.json').toUpperCase();
      }

      // Memory safeguard: avoid loading massive bulk open-data datasets (> 5 MB)
      // into the in-memory Google cache index. Bulk datasets (e.g. GeoNames India with 560,000+ records)
      // are searched on-demand with bounded memory by LocalGeoNamesResolver.
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > 5 * 1024 * 1024 || (!file.endsWith('.cache.json') && this.exporter.hasBulkExport(countryCode))) {
          logger.info(
            { countryCode, sizeBytes: stats.size },
            'Skipping bulk open-data file from in-memory Google cache index (delegated to LocalGeoNamesResolver)'
          );
          continue;
        }
      } catch {
        // Continue if stat fails
      }

      const records = file.endsWith('.cache.json')
        ? this.exporter.loadCountryCacheRecords(countryCode)
        : this.exporter.loadCountryRecords(countryCode);

      for (const record of records) {
        this.indexRecord(record);
        loadedCount++;
      }
    }

    this.stats.totalCached = this.cacheIndex.size;
    this.isInitialized = true;
    logger.info({ totalLoaded: loadedCount, uniqueKeys: this.cacheIndex.size }, 'Location JSON cache initialized');
    return this.cacheIndex.size;
  }

  private indexRecord(record: LocationRecord): void {
    const key = LocationCacheService.buildCacheKey(record.name, record.countryCode);
    this.cacheIndex.set(key, record);

    if (record.asciiName && record.asciiName.toLowerCase() !== record.name.toLowerCase()) {
      const asciiKey = LocationCacheService.buildCacheKey(record.asciiName, record.countryCode);
      this.cacheIndex.set(asciiKey, record);
    }

    if (record.id) {
      this.idIndex.set(record.id, record);
    }
  }

  /**
   * Checks whether a cached record is within the freshness TTL.
   */
  public isFresh(record: LocationRecord): boolean {
    // Open-data records (e.g. GeoNames under CC-BY 4.0) do not expire under Google ToS 30-day limits
    if (record.source === 'geonames') {
      return true;
    }

    if (!record.updatedAt) {
      return false;
    }

    const ageMs = Date.now() - new Date(record.updatedAt).getTime();
    const maxAgeMs = this.cacheTtlDays * 24 * 60 * 60 * 1000;
    return ageMs >= 0 && ageMs < maxAgeMs;
  }

  /**
   * Location lookup following strict resolution order:
   * 1. Validate input (cityName non-empty, valid 2-letter ISO countryCode if provided).
   * 2. Search local GeoNames dataset (data/locations/india/cities.json & states.json) -> HIT (0 API calls).
   * 3. Check eligible Google-backed cache (in-memory & JSON files) -> HIT if < 30 days old (0 API calls).
   * 4. Cache MISS -> Singleflight coalesced Google Maps Platform API call.
   */
  public async lookup(cityName: string, countryCode?: string): Promise<CacheLookupResult> {
    // Step 1: Input Validation
    const trimmedCity = cityName?.trim();
    if (!trimmedCity) {
      return {
        status: 'VALID_EMPTY',
        record: null,
        fromCache: false,
        refreshed: false,
        error: 'City name must not be empty',
        cacheKey: ''
      };
    }

    const normCountry = countryCode ? countryCode.trim().toUpperCase() : undefined;
    if (normCountry && !/^[A-Z]{2}$/.test(normCountry)) {
      return {
        status: 'VALID_EMPTY',
        record: null,
        fromCache: false,
        refreshed: false,
        error: `Invalid country code format: "${countryCode}". Expected 2-letter ISO code.`,
        cacheKey: LocationCacheService.buildCacheKey(trimmedCity, countryCode)
      };
    }

    const cacheKey = LocationCacheService.buildCacheKey(trimmedCity, normCountry);

    // Request Coalescing (Singleflight across entire lookup pipeline)
    // Ensures concurrent requests for the exact same location share the entire resolution
    // including local GeoNames search, cache checking, and any external API call.
    const existingInFlight = this.inFlightRequests.get(cacheKey);
    if (existingInFlight) {
      logger.debug({ cacheKey }, 'Coalescing concurrent identical lookup request');
      return existingInFlight;
    }

    const lookupPromise = this.executeLookupPipeline(trimmedCity, normCountry, cacheKey);
    this.inFlightRequests.set(cacheKey, lookupPromise);

    try {
      return await lookupPromise;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  private async executeLookupPipeline(
    trimmedCity: string,
    normCountry: string | undefined,
    cacheKey: string
  ): Promise<CacheLookupResult> {
    // In-memory negative cache check: avoid repeating API queries for known unresolvable locations
    const negTime = this.negativeCache.get(cacheKey);
    if (negTime) {
      if (Date.now() - negTime < this.negativeCacheTtlMs) {
        logger.debug({ cacheKey }, 'Negative cache HIT: returning known empty result (0 external API calls)');
        return {
          status: 'VALID_EMPTY',
          record: null,
          fromCache: true,
          refreshed: false,
          cacheKey
        };
      } else {
        this.negativeCache.delete(cacheKey);
      }
    }

    // Step 2: Search Local GeoNames Dataset (Zero Google API calls)
    const localHit = await this.localResolver.findLocation(trimmedCity, normCountry);
    if (localHit) {
      this.stats.hits++;
      logger.info(
        { cityName: trimmedCity, countryCode: normCountry, id: localHit.id, source: localHit.source },
        'Local GeoNames HIT: resolved from local open dataset (0 external API calls)'
      );
      return {
        status: 'HIT',
        record: localHit,
        fromCache: true,
        refreshed: false,
        cacheKey
      };
    }

    // Step 3: Check Eligible Google-Backed Cache
    await this.initCache();
    const cached = this.cacheIndex.get(cacheKey);

    // Case 3A: Fresh Cache HIT (< 30 days TTL)
    if (cached && this.isFresh(cached)) {
      this.stats.hits++;
      logger.debug({ cityName: trimmedCity, countryCode: normCountry, cacheKey }, 'Cache HIT: returning fresh cached location');
      return {
        status: 'HIT',
        record: cached,
        fromCache: true,
        refreshed: false,
        cacheKey
      };
    }

    // Case 3B: Expired Cache record (>= 30 days TTL) - Refresh on eligible user lookup
    if (cached && !this.isFresh(cached)) {
      this.stats.expiredHits++;
      logger.info({ cityName: trimmedCity, countryCode: normCountry, updatedAt: cached.updatedAt }, 'Cache EXPIRED: attempting refresh');

      try {
        const refreshedRecord = await this.apiClient.fetchLocation(trimmedCity, normCountry || cached.countryCode);
        if (refreshedRecord) {
          await this.exporter.upsertCountryRecord(refreshedRecord);
          this.indexRecord(refreshedRecord);
          this.stats.refreshes++;
          this.stats.totalCached = this.cacheIndex.size;

          return {
            status: 'EXPIRED',
            record: refreshedRecord,
            fromCache: false,
            refreshed: true,
            cacheKey
          };
        }
      } catch (err: any) {
        logger.warn(
          { cityName: trimmedCity, error: err.message },
          'Failed refreshing expired record via API, falling back to existing cache'
        );
        // Resilient fallback: return existing cached data on refresh failure
        return {
          status: 'EXPIRED',
          record: cached,
          fromCache: true,
          refreshed: false,
          error: `Refresh failed: ${err.message}. Served from stale cache.`,
          cacheKey
        };
      }
    }

    // Step 4: Cache MISS -> External Google Maps Platform API call
    return await this.executeFetchAndCache(trimmedCity, normCountry, cacheKey);
  }

  private async executeFetchAndCache(
    cityName: string,
    countryCode: string | undefined,
    cacheKey: string
  ): Promise<CacheLookupResult> {
    this.stats.misses++;
    logger.info({ cityName, countryCode, cacheKey }, 'Cache MISS: calling external API');

    try {
      const record = await this.apiClient.fetchLocation(cityName, countryCode);

      if (!record) {
        logger.info({ cityName, countryCode }, 'API returned no matching location');
        this.negativeCache.set(cacheKey, Date.now());
        return {
          status: 'VALID_EMPTY',
          record: null,
          fromCache: false,
          refreshed: false,
          cacheKey
        };
      }

      // Persist to structured JSON file
      await this.exporter.upsertCountryRecord(record);
      this.indexRecord(record);
      this.stats.totalCached = this.cacheIndex.size;

      logger.info({ id: record.id, name: record.name, country: record.countryCode }, 'Cached new location to JSON');

      return {
        status: 'MISS',
        record,
        fromCache: false,
        refreshed: false,
        cacheKey
      };
    } catch (err: any) {
      this.stats.failures++;
      logger.error({ cityName, countryCode, error: err.message }, 'API failure during location lookup');

      const isRateLimit = err.message.includes('429') || err.message.includes('OVER_QUERY_LIMIT');

      return {
        status: isRateLimit ? 'RATE_LIMITED' : 'API_FAILURE',
        record: null,
        fromCache: false,
        refreshed: false,
        error: err.message,
        cacheKey
      };
    }
  }

  /**
   * Permitted Scheduled Cache Maintenance:
   * In compliance with Google Maps Platform Terms of Service Section 3.2.3(a) and
   * Service-Specific Terms for the Geocoding API:
   * - Cached latitude and longitude values may only be retained for up to 30 calendar days.
   * - After 30 days, the customer MUST delete or re-request the cached values.
   * - Autonomous background re-requesting without user intent is prohibited pre-fetching.
   *
   * Therefore, this scheduled maintenance job inspects all cached records, identifies
   * those exceeding the 30-day TTL, and PRUNES them from the persistent store.
   * ZERO external API calls are made during scheduled cron maintenance.
   * Re-fetching is strictly deferred until an active, eligible user lookup occurs.
   */
  public async pruneExpiredRecords(): Promise<{
    checked: number;
    pruned: number;
    retained: number;
  }> {
    await this.initCache();

    const allRecords = Array.from(this.idIndex.values());
    let checked = 0;
    let pruned = 0;
    let retained = 0;

    const countriesToUpdate = new Set<string>();

    for (const record of allRecords) {
      checked++;
      if (!this.isFresh(record)) {
        pruned++;
        const key = LocationCacheService.buildCacheKey(record.name, record.countryCode);
        this.cacheIndex.delete(key);
        if (record.asciiName) {
          const asciiKey = LocationCacheService.buildCacheKey(record.asciiName, record.countryCode);
          this.cacheIndex.delete(asciiKey);
        }
        this.idIndex.delete(record.id);
        countriesToUpdate.add(record.countryCode);

        logger.info(
          { id: record.id, name: record.name, country: record.countryCode, ageDays: this.getAgeDays(record) },
          'Pruned expired record to enforce Google Maps 30-day cache policy'
        );
      } else {
        retained++;
      }
    }

    if (countriesToUpdate.size > 0) {
      for (const countryCode of countriesToUpdate) {
        const remainingForCountry = Array.from(this.idIndex.values()).filter(
          (r) => r.countryCode.toUpperCase() === countryCode.toUpperCase()
        );
        remainingForCountry.sort((a, b) => a.name.localeCompare(b.name));
        await this.exporter.saveCountryRecords(countryCode, remainingForCountry);
      }
      await this.exporter.refreshCacheManifest();
    }

    this.stats.totalCached = this.cacheIndex.size;
    logger.info({ checked, pruned, retained }, 'Cache maintenance cycle completed (0 external API calls)');
    return { checked, pruned, retained };
  }

  public getAgeDays(record: LocationRecord): number {
    if (!record.updatedAt) return Infinity;
    return Math.floor((Date.now() - new Date(record.updatedAt).getTime()) / (24 * 60 * 60 * 1000));
  }

  /**
   * Refreshes cached records on-demand (Manual/Administrative user-directed operation only).
   * Note: Automated background refresh without user intent is prohibited by Google Maps ToS.
   */
  public async refreshStaleRecords(options?: { forceAll?: boolean }): Promise<{
    checked: number;
    refreshed: number;
    skipped: number;
    failed: number;
  }> {
    await this.initCache();

    const allRecords = Array.from(this.idIndex.values());
    let checked = 0;
    let refreshed = 0;
    let skipped = 0;
    let failed = 0;

    logger.info({ totalRecords: allRecords.length, forceAll: !!options?.forceAll }, 'Starting stale cache refresh');

    for (const record of allRecords) {
      checked++;
      const isStale = !this.isFresh(record) || !record.timezone;

      if (!isStale && !options?.forceAll) {
        skipped++;
        continue;
      }

      try {
        logger.info({ name: record.name, country: record.countryCode }, 'Refreshing eligible location');
        const updated = await this.apiClient.fetchLocation(record.name, record.countryCode);
        if (updated) {
          await this.exporter.upsertCountryRecord(updated);
          this.indexRecord(updated);
          refreshed++;
        } else {
          skipped++;
        }
      } catch (err: any) {
        failed++;
        logger.warn({ name: record.name, country: record.countryCode, error: err.message }, 'Failed refreshing record');
      }

      // Small throttle between API refresh requests (100ms)
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    logger.info({ checked, refreshed, skipped, failed }, 'Finished cache refresh');
    return { checked, refreshed, skipped, failed };
  }

  public getRecordById(id: string): LocationRecord | null {
    return this.idIndex.get(id) || null;
  }

  public getAllCachedRecords(): LocationRecord[] {
    return Array.from(this.idIndex.values());
  }

  public getStats(): CacheStats {
    return { ...this.stats, totalCached: this.cacheIndex.size };
  }

  public clearInMemoryCache(): void {
    this.cacheIndex.clear();
    this.idIndex.clear();
    this.negativeCache.clear();
    this.inFlightRequests.clear();
    this.localResolver.clearCache();
    this.isInitialized = false;
  }

  public getLocalResolver(): LocalGeoNamesResolver {
    return this.localResolver;
  }
}

export const defaultCacheService = new LocationCacheService();
export default defaultCacheService;
