import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationCacheService } from '../../src/cache/index.js';
import { LocalGeoNamesResolver } from '../../src/cache/localResolver.js';
import { GoogleMapsApiClient } from '../../src/apiClient/index.js';
import { LocationExporter } from '../../src/exporter/index.js';
import type { LocationRecord } from '../../src/types.js';

describe('Worldwide Major-City Coverage & Country-Aware Resolution', () => {
  const prodDataDir = path.resolve('data/locations');

  describe('1. Offline Local GeoNames Resolution (Zero External API Calls)', () => {
    let resolver: LocalGeoNamesResolver;
    let mockApiClient: GoogleMapsApiClient;
    let cacheService: LocationCacheService;

    beforeEach(() => {
      resolver = new LocalGeoNamesResolver({ dataDir: prodDataDir });
      mockApiClient = new GoogleMapsApiClient({
        apiKey: 'test-fake-key',
        apiBaseUrl: 'https://fake-maps-api'
      });
      cacheService = new LocationCacheService({
        apiClient: mockApiClient,
        localResolver: resolver,
        exporter: new LocationExporter(prodDataDir),
        cacheTtlDays: 30
      });
    });

    it('resolves representative worldwide major cities locally with 0 API calls', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation');

      const majorCities: [string, string, string][] = [
        ['Tokyo', 'JP', 'PPLC'],
        ['Paris', 'FR', 'PPLC'],
        ['London', 'GB', 'PPLC'],
        ['Berlin', 'DE', 'PPLC'],
        ['New York City', 'US', 'PPL'],
        ['Sydney', 'AU', 'PPLA'],
        ['Toronto', 'CA', 'PPLA'],
        ['Beijing', 'CN', 'PPLC'],
        ['Brasília', 'BR', 'PPLC'],
        ['Rome', 'IT', 'PPLC'],
        ['Cairo', 'EG', 'PPLC']
      ];

      for (const [cityName, countryCode, expectedFeature] of majorCities) {
        const start = performance.now();
        const result = await cacheService.lookup(cityName, countryCode);
        const durationMs = performance.now() - start;

        expect(result.status).toBe('HIT');
        expect(result.fromCache).toBe(true);
        expect(result.record).toBeDefined();
        expect(result.record?.countryCode).toBe(countryCode);
        expect(result.record?.source).toBe('geonames');
        expect(result.record?.featureCode).toBe(expectedFeature);
        expect(durationMs).toBeLessThan(100); // Sub-millisecond or fast indexed disk read
      }

      // Strictly zero external API calls
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('preserves comprehensive India coverage with zero API calls', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation');

      const indiaLocations = [
        { name: 'Mumbai', code: 'PPLA', popMin: 10000000 },
        { name: 'New Delhi', code: 'PPLC', popMin: 200000 }
      ];

      for (const loc of indiaLocations) {
        const result = await cacheService.lookup(loc.name, 'IN');
        expect(result.status).toBe('HIT');
        expect(result.fromCache).toBe(true);
        expect(result.record?.countryCode).toBe('IN');
        expect(result.record?.featureCode).toBe(loc.code);
        expect(result.record?.population).toBeGreaterThan(loc.popMin);
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resolves historical and colloquial city aliases locally without API fallback', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation');

      const aliases = [
        { query: 'Bombay', country: 'IN', expectedName: 'Mumbai' },
        { query: 'Bangalore', country: 'IN', expectedName: 'Bengaluru' },
        { query: 'Calcutta', country: 'IN', expectedName: 'Kolkata' },
        { query: 'Madras', country: 'IN', expectedName: 'Chennai' },
        { query: 'New York', country: 'US', expectedName: 'New York City' },
        { query: 'Peking', country: 'CN', expectedName: 'Beijing' }
      ];

      for (const alias of aliases) {
        const result = await cacheService.lookup(alias.query, alias.country);
        expect(result.status).toBe('HIT');
        expect(result.fromCache).toBe(true);
        expect(result.record?.name).toBe(alias.expectedName);
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('2. Disambiguation Across Worldwide Countries', () => {
    let resolver: LocalGeoNamesResolver;

    beforeEach(() => {
      resolver = new LocalGeoNamesResolver({ dataDir: prodDataDir });
    });

    it('disambiguates Paris between France capital and US towns correctly', async () => {
      // 1. Without country filter, national capital (Paris, FR) wins
      const globalParis = await resolver.findLocation('Paris');
      expect(globalParis).toBeDefined();
      expect(globalParis?.countryCode).toBe('FR');
      expect(globalParis?.featureCode).toBe('PPLC');
      expect(globalParis?.population).toBeGreaterThan(2000000);

      // 2. Explicit US filter resolves to Paris, Texas / US
      const usParis = await resolver.findLocation('Paris', 'US');
      expect(usParis).toBeDefined();
      expect(usParis?.countryCode).toBe('US');
      expect(usParis?.admin1Name).toBe('Texas');

      // 3. Explicit FR filter resolves to Paris, France
      const frParis = await resolver.findLocation('Paris', 'FR');
      expect(frParis).toBeDefined();
      expect(frParis?.countryCode).toBe('FR');
      expect(frParis?.id).toBe(globalParis?.id);
    });

    it('disambiguates London between United Kingdom capital and London, Ontario', async () => {
      // 1. Without country filter, UK mega-city & national capital (London, GB) wins
      const globalLondon = await resolver.findLocation('London');
      expect(globalLondon).toBeDefined();
      expect(globalLondon?.countryCode).toBe('GB');
      expect(globalLondon?.featureCode).toBe('PPLC');
      expect(globalLondon?.population).toBeGreaterThan(8000000);

      // 2. Explicit CA filter resolves to London, Ontario
      const caLondon = await resolver.findLocation('London', 'CA');
      expect(caLondon).toBeDefined();
      expect(caLondon?.countryCode).toBe('CA');
      expect(caLondon?.admin1Name).toBe('Ontario');

      // 3. Explicit GB filter resolves to London, UK
      const gbLondon = await resolver.findLocation('London', 'GB');
      expect(gbLondon).toBeDefined();
      expect(gbLondon?.countryCode).toBe('GB');
      expect(gbLondon?.id).toBe(globalLondon?.id);
    });
  });

  describe('3. Local Miss -> Google API Fallback & Cache Separation', () => {
    let tempDir: string;
    let exporter: LocationExporter;
    let mockApiClient: GoogleMapsApiClient;
    let cacheService: LocationCacheService;

    const mockUSCustomPlace: LocationRecord = {
      id: 'ChIJ_US_Custom_Innovation_District',
      name: 'Silicon Valley Innovation Hub',
      asciiName: 'Silicon Valley Innovation Hub',
      countryCode: 'US',
      countryName: 'United States',
      admin1Code: 'CA',
      admin1Name: 'California',
      admin2Code: 'Santa Clara',
      featureClass: null,
      featureCode: null,
      types: ['establishment', 'point_of_interest'],
      latitude: 37.3861,
      longitude: -122.0839,
      timezone: 'America/Los_Angeles',
      population: null,
      elevation: null,
      modificationDate: null,
      source: 'google-maps',
      updatedAt: new Date().toISOString()
    };

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldwide-cache-'));
      exporter = new LocationExporter(tempDir);

      // Create a mock US bulk directory so exporter treats US as having bulk data
      const usDir = exporter.getCountryDir('US');
      fs.mkdirSync(usDir, { recursive: true });
      fs.writeFileSync(path.join(usDir, 'cities.json'), '[\n  {"id":"1","name":"ExistingCity","countryCode":"US"}\n]\n');

      mockApiClient = new GoogleMapsApiClient({
        apiKey: 'test-fake-key',
        apiBaseUrl: 'https://fake-maps-api'
      });

      cacheService = new LocationCacheService({
        apiClient: mockApiClient,
        exporter,
        cacheTtlDays: 30
      });
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      vi.restoreAllMocks();
    });

    it('falls back to Google API on local miss and saves to US.cache.json without altering cities.json', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockUSCustomPlace);

      // First lookup: Local Miss -> Google API call -> Saved to US.cache.json
      const result1 = await cacheService.lookup('Silicon Valley Innovation Hub', 'US');

      expect(result1.status).toBe('MISS');
      expect(result1.fromCache).toBe(false);
      expect(result1.record?.id).toBe(mockUSCustomPlace.id);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Verify written to US.cache.json (NOT us/cities.json)
      const cachePath = exporter.getCountryCacheFilePath('US');
      expect(cachePath.endsWith('US.cache.json')).toBe(true);
      expect(fs.existsSync(cachePath)).toBe(true);

      const cachedRecords: LocationRecord[] = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(cachedRecords.length).toBe(1);
      expect(cachedRecords[0].name).toBe('Silicon Valley Innovation Hub');
      expect(cachedRecords[0].source).toBe('google-maps');

      // Second lookup: Cache HIT (0 additional API calls)
      const result2 = await cacheService.lookup('Silicon Valley Innovation Hub', 'US');
      expect(result2.status).toBe('HIT');
      expect(result2.fromCache).toBe(true);
      expect(result2.record?.id).toBe(mockUSCustomPlace.id);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // Still 1 call
    });

    it('handles negative caching for non-existent locations to avoid repeated API calls', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(null);

      // First lookup: API returns null (ZERO_RESULTS)
      const result1 = await cacheService.lookup('CompletelyFictionalCity999', 'US');
      expect(result1.status).toBe('VALID_EMPTY');
      expect(result1.fromCache).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second lookup: Negative cache HIT (0 extra API calls)
      const result2 = await cacheService.lookup('CompletelyFictionalCity999', 'US');
      expect(result2.status).toBe('VALID_EMPTY');
      expect(result2.fromCache).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // No second call
    });
  });

  describe('4. Google Cache Expiry & Maintenance', () => {
    let tempDir: string;
    let exporter: LocationExporter;
    let mockApiClient: GoogleMapsApiClient;
    let cacheService: LocationCacheService;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worldwide-pruning-'));
      exporter = new LocationExporter(tempDir);
      mockApiClient = new GoogleMapsApiClient({ apiKey: 'fake', apiBaseUrl: 'https://fake' });
      cacheService = new LocationCacheService({ apiClient: mockApiClient, exporter, cacheTtlDays: 30 });
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('prunes expired Google cache entries while preserving valid ones and untouched open data', async () => {
      const now = Date.now();
      const freshRecord: LocationRecord = {
        id: 'ChIJ_Fresh_London',
        name: 'Canary Wharf Business Center',
        asciiName: 'Canary Wharf Business Center',
        countryCode: 'GB',
        countryName: 'United Kingdom',
        admin1Code: 'ENG',
        admin1Name: 'England',
        admin2Code: 'Greater London',
        featureClass: null,
        featureCode: null,
        latitude: 51.5054,
        longitude: -0.0235,
        timezone: 'Europe/London',
        population: null,
        elevation: null,
        modificationDate: null,
        source: 'google-maps',
        updatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString() // 5 days old (fresh)
      };

      const expiredRecord: LocationRecord = {
        id: 'ChIJ_Expired_London',
        name: 'Old Docklands Site',
        asciiName: 'Old Docklands Site',
        countryCode: 'GB',
        countryName: 'United Kingdom',
        admin1Code: 'ENG',
        admin1Name: 'England',
        admin2Code: 'Greater London',
        featureClass: null,
        featureCode: null,
        latitude: 51.5000,
        longitude: -0.0100,
        timezone: 'Europe/London',
        population: null,
        elevation: null,
        modificationDate: null,
        source: 'google-maps',
        updatedAt: new Date(now - 45 * 24 * 60 * 60 * 1000).toISOString() // 45 days old (expired)
      };

      // Write directly to GB.cache.json
      const countriesDir = exporter.getCountriesDir();
      fs.mkdirSync(countriesDir, { recursive: true });
      const gbCachePath = path.join(countriesDir, 'GB.cache.json');
      fs.writeFileSync(gbCachePath, JSON.stringify([freshRecord, expiredRecord], null, 2));

      // Run cache maintenance
      const stats = await cacheService.pruneExpiredRecords();

      expect(stats.checked).toBe(2);
      expect(stats.pruned).toBe(1);
      expect(stats.retained).toBe(1);

      // Verify file on disk now only contains the fresh record
      const updatedGbRecords: LocationRecord[] = JSON.parse(fs.readFileSync(gbCachePath, 'utf8'));
      expect(updatedGbRecords.length).toBe(1);
      expect(updatedGbRecords[0].name).toBe('Canary Wharf Business Center');
    });
  });
});
