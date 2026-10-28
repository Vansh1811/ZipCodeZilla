import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationCacheService } from '../../src/cache/index.js';
import { GoogleMapsApiClient } from '../../src/apiClient/index.js';
import { LocationExporter } from '../../src/exporter/index.js';
import type { LocationRecord, PipelineManifest } from '../../src/types.js';

describe('Cache Separation & Manifest Attribution Integrity', () => {
  let tempDir: string;
  let exporter: LocationExporter;
  let mockApiClient: GoogleMapsApiClient;
  let cacheService: LocationCacheService;

  const mockBulkIndiaRecord: LocationRecord = {
    id: '1269843',
    name: 'Hyderabad',
    asciiName: 'Hyderabad',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: '40',
    admin1Name: 'Telangana',
    admin2Code: null,
    featureClass: 'P',
    featureCode: 'PPLA',
    latitude: 17.38405,
    longitude: 78.45636,
    timezone: 'Asia/Kolkata',
    population: 6809970,
    elevation: 515,
    modificationDate: '2024-01-15',
    source: 'geonames',
    updatedAt: new Date().toISOString()
  };

  const mockGoogleIndiaRecord: LocationRecord = {
    id: 'ChIJ_Custom_Google_Place_ID',
    name: 'Cyber City Gurugram',
    asciiName: 'Cyber City Gurugram',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: 'HR',
    admin1Name: 'Haryana',
    admin2Code: 'Gurgaon',
    featureClass: null,
    featureCode: null,
    types: ['establishment', 'point_of_interest'],
    latitude: 28.4950,
    longitude: 77.0895,
    timezone: 'Asia/Kolkata',
    population: null,
    elevation: null,
    modificationDate: null,
    source: 'google-maps',
    updatedAt: new Date().toISOString()
  };

  const mockFranceRecord: LocationRecord = {
    id: 'ChIJD7fiBh9u5kcRYJSMaMOCCwQ',
    name: 'Paris',
    asciiName: 'Paris',
    countryCode: 'FR',
    countryName: 'France',
    admin1Code: 'IDF',
    admin1Name: 'Île-de-France',
    admin2Code: 'Paris',
    featureClass: null,
    featureCode: null,
    types: ['locality', 'political'],
    latitude: 48.8575,
    longitude: 2.3514,
    timezone: 'Europe/Paris',
    population: null,
    elevation: null,
    modificationDate: null,
    source: 'google-maps',
    updatedAt: new Date().toISOString()
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-sep-test-'));
    exporter = new LocationExporter(tempDir);

    // Mock API client
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

  it('Fix 1 & Fix 2: Preserves GeoNames manifest.json attribution and checksums when cache records are written', async () => {
    // 1. Establish an initial GeoNames manifest describing bulk data
    const bulkManifest: PipelineManifest = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: 'geonames',
      license: 'Creative Commons Attribution 4.0 International (CC-BY 4.0)',
      attribution: 'GeoNames (geonames.org)',
      totalRecords: 1,
      countryCoverage: [{ code: 'IN', name: 'India', recordCount: 1 }],
      status: 'completed',
      checksums: {
        'countries/IN.json': 'e49ee2e8b86bbd5d3603ed66e31e456e0d471b2a91f0cdee957786bd54bc9bc4'
      }
    };
    await exporter.writeManifest(bulkManifest);

    // 2. Perform a Google cache write for France
    await exporter.upsertCountryRecord(mockFranceRecord);

    // 3. Verify manifest.cache.json was created with Google attribution
    const cacheManifestPath = exporter.getCacheManifestFilePath();
    expect(fs.existsSync(cacheManifestPath)).toBe(true);
    const cacheManifest: PipelineManifest = JSON.parse(fs.readFileSync(cacheManifestPath, 'utf8'));
    expect(cacheManifest.source).toBe('google-maps');
    expect(cacheManifest.attribution).toContain('Google Maps');
    expect(cacheManifest.totalRecords).toBe(1);
    expect(cacheManifest.checksums['countries/FR.json']).toBeDefined();

    // 4. PROOF of Fix 1 & 2: bulk manifest.json was NOT overwritten with Google Maps metadata!
    const bulkManifestAfter: PipelineManifest = JSON.parse(
      fs.readFileSync(exporter.getManifestFilePath(), 'utf8')
    );
    expect(bulkManifestAfter.source).toBe('geonames');
    expect(bulkManifestAfter.license).toContain('Creative Commons');
    expect(bulkManifestAfter.attribution).toBe('GeoNames (geonames.org)');
    expect(bulkManifestAfter.checksums['countries/IN.json']).toBe(
      'e49ee2e8b86bbd5d3603ed66e31e456e0d471b2a91f0cdee957786bd54bc9bc4'
    );
  });

  it('Fix 3: Stores Google cache records for countries with bulk exports in .cache.json without touching bulk files', async () => {
    // 1. Simulate existing India bulk export in countries/IN.json and india/cities.json
    const inJsonPath = exporter.getCountryFilePath('IN');
    const citiesPath = exporter.getIndiaCitiesFilePath();
    fs.mkdirSync(path.dirname(inJsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(citiesPath), { recursive: true });

    // Write simulated bulk files (> 5 MB to trigger bulk dataset detection)
    const padding = ' '.repeat(6 * 1024 * 1024);
    fs.writeFileSync(inJsonPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');
    fs.writeFileSync(citiesPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');

    expect(exporter.hasBulkExport('IN')).toBe(true);
    expect(exporter.getCountryCacheFilePath('IN')).toBe(
      path.join(exporter.getCountriesDir(), 'IN.cache.json')
    );

    // Spy on readFileSync to prove that countries/IN.json and india/cities.json are NEVER read during cache upsert
    const readSpy = vi.spyOn(fs, 'readFileSync');

    // 2. Upsert a new Google cache record for India
    await exporter.upsertCountryRecord(mockGoogleIndiaRecord);

    // Verify readFileSync was NOT called on the bulk files
    const readPaths = readSpy.mock.calls.map((c) => String(c[0]));
    expect(readPaths).not.toContain(inJsonPath);
    expect(readPaths).not.toContain(citiesPath);

    // 3. Verify the cache record was stored cleanly in IN.cache.json
    const inCachePath = path.join(exporter.getCountriesDir(), 'IN.cache.json');
    expect(fs.existsSync(inCachePath)).toBe(true);

    const cacheRecords: LocationRecord[] = JSON.parse(fs.readFileSync(inCachePath, 'utf8'));
    expect(cacheRecords.length).toBe(1);
    expect(cacheRecords[0].name).toBe('Cyber City Gurugram');
    expect(cacheRecords[0].source).toBe('google-maps');

    // 4. Verify bulk IN.json and cities.json contents were NOT modified or overwritten
    const bulkRecordsAfter: LocationRecord[] = JSON.parse(fs.readFileSync(inJsonPath, 'utf8'));
    expect(bulkRecordsAfter.length).toBe(1);
    expect(bulkRecordsAfter[0].name).toBe('Hyderabad');
    expect(bulkRecordsAfter[0].source).toBe('geonames');

    const citiesAfter: LocationRecord[] = JSON.parse(fs.readFileSync(citiesPath, 'utf8'));
    expect(citiesAfter.length).toBe(1);
    expect(citiesAfter[0].name).toBe('Hyderabad');
  });

  it('Fix 3 (Lookup & Indexing): Correctly indexes IN.cache.json and serves cache hits with 0 API calls', async () => {
    // 1. Setup bulk export and IN.cache.json
    const inJsonPath = exporter.getCountryFilePath('IN');
    const citiesPath = exporter.getIndiaCitiesFilePath();
    fs.mkdirSync(path.dirname(inJsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(citiesPath), { recursive: true });
    const padding = ' '.repeat(6 * 1024 * 1024);
    fs.writeFileSync(inJsonPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');
    fs.writeFileSync(citiesPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');

    // Pre-populate IN.cache.json
    const inCachePath = path.join(exporter.getCountriesDir(), 'IN.cache.json');
    fs.writeFileSync(inCachePath, JSON.stringify([mockGoogleIndiaRecord]), 'utf8');

    // 2. Initialize cache
    await cacheService.initCache();

    // Spy on API client
    const apiSpy = vi.spyOn(mockApiClient, 'fetchLocation');

    // 3. Lookup the location stored in IN.cache.json
    const result = await cacheService.lookup('Cyber City Gurugram', 'IN');

    expect(result.status).toBe('HIT');
    expect(result.fromCache).toBe(true);
    expect(result.record?.name).toBe('Cyber City Gurugram');
    expect(result.record?.source).toBe('google-maps');
    expect(apiSpy).toHaveBeenCalledTimes(0); // Zero external calls!
  });

  it('Fix 3 (Pruning): Scheduled pruning prunes expired entries in IN.cache.json without touching bulk data', async () => {
    // 1. Setup bulk export and IN.cache.json with an expired record
    const inJsonPath = exporter.getCountryFilePath('IN');
    const citiesPath = exporter.getIndiaCitiesFilePath();
    fs.mkdirSync(path.dirname(inJsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(citiesPath), { recursive: true });
    const padding = ' '.repeat(6 * 1024 * 1024);
    fs.writeFileSync(inJsonPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');
    fs.writeFileSync(citiesPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');

    const expiredGoogleRecord: LocationRecord = {
      ...mockGoogleIndiaRecord,
      updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() // 40 days old (> 30 days)
    };

    const inCachePath = path.join(exporter.getCountriesDir(), 'IN.cache.json');
    fs.writeFileSync(inCachePath, JSON.stringify([expiredGoogleRecord]), 'utf8');

    // 2. Initialize and run pruneExpiredRecords
    await cacheService.initCache();
    const pruneReport = await cacheService.pruneExpiredRecords();

    expect(pruneReport.checked).toBe(1);
    expect(pruneReport.pruned).toBe(1);

    // 3. Verify IN.cache.json was pruned
    const cacheRemaining: LocationRecord[] = JSON.parse(fs.readFileSync(inCachePath, 'utf8'));
    expect(cacheRemaining.length).toBe(0);

    // 4. Verify bulk IN.json and cities.json remain completely untouched
    const bulkRemaining: LocationRecord[] = JSON.parse(fs.readFileSync(inJsonPath, 'utf8'));
    expect(bulkRemaining.length).toBe(1);
    expect(bulkRemaining[0].name).toBe('Hyderabad');
  });

  it('Task 1: Complete end-to-end India cache lifecycle (miss -> API fetch -> persist IN.cache.json -> warm hit -> cold restart hit)', async () => {
    // 1. Initialize isolated environment with bulk data for IN (> 5 MB)
    const inJsonPath = exporter.getCountryFilePath('IN');
    const citiesPath = exporter.getIndiaCitiesFilePath();
    const statesPath = exporter.getIndiaStatesFilePath();
    fs.mkdirSync(path.dirname(inJsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(citiesPath), { recursive: true });
    fs.mkdirSync(path.dirname(statesPath), { recursive: true });

    const padding = ' '.repeat(6 * 1024 * 1024);
    fs.writeFileSync(inJsonPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');
    fs.writeFileSync(citiesPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');
    fs.writeFileSync(statesPath, '[]', 'utf8');

    const bulkManifest: PipelineManifest = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: 'geonames',
      license: 'Creative Commons Attribution 4.0 International (CC-BY 4.0)',
      attribution: 'GeoNames (geonames.org)',
      totalRecords: 1,
      countryCoverage: [{ code: 'IN', name: 'India', recordCount: 1 }],
      status: 'completed',
      checksums: {
        'countries/IN.json': await LocationExporter.calculateFileChecksum(inJsonPath),
        'india/cities.json': await LocationExporter.calculateFileChecksum(citiesPath)
      }
    };
    await exporter.writeManifest(bulkManifest);

    const initialInHash = bulkManifest.checksums['countries/IN.json'];
    const initialCitiesHash = bulkManifest.checksums['india/cities.json'];

    // 2. Ensure local GeoNames resolver will NOT find the test location
    const localHit = await cacheService.getLocalResolver().findLocation('Cyber City Gurugram', 'IN');
    expect(localHit).toBeNull();

    // 3. Configure Google API client with deterministic mock response
    const apiSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockGoogleIndiaRecord);

    // 4. First lookup for uncached location (Cache MISS)
    const res1 = await cacheService.lookup('Cyber City Gurugram', 'IN');

    // 5. Assert lookup succeeds and mock API called exactly once
    expect(res1.status).toBe('MISS');
    expect(res1.fromCache).toBe(false);
    expect(res1.record?.name).toBe('Cyber City Gurugram');
    expect(res1.record?.id).toBe(mockGoogleIndiaRecord.id);
    expect(apiSpy).toHaveBeenCalledTimes(1);

    // 6. Assert Google cache record is written to IN.cache.json
    const inCachePath = path.join(exporter.getCountriesDir(), 'IN.cache.json');
    expect(fs.existsSync(inCachePath)).toBe(true);
    const inCacheRecords: LocationRecord[] = JSON.parse(fs.readFileSync(inCachePath, 'utf8'));
    expect(inCacheRecords.length).toBe(1);
    expect(inCacheRecords[0].name).toBe('Cyber City Gurugram');
    expect(inCacheRecords[0].source).toBe('google-maps');

    // 7. Assert bulk files and manifest.json remain unchanged
    const bulkInRecords: LocationRecord[] = JSON.parse(fs.readFileSync(inJsonPath, 'utf8'));
    expect(bulkInRecords.length).toBe(1);
    expect(bulkInRecords[0].name).toBe('Hyderabad');
    expect(await LocationExporter.calculateFileChecksum(inJsonPath)).toBe(initialInHash);
    expect(await LocationExporter.calculateFileChecksum(citiesPath)).toBe(initialCitiesHash);

    const manifestAfterMiss: PipelineManifest = JSON.parse(
      fs.readFileSync(exporter.getManifestFilePath(), 'utf8')
    );
    expect(manifestAfterMiss.source).toBe('geonames');
    expect(manifestAfterMiss.license).toBe('Creative Commons Attribution 4.0 International (CC-BY 4.0)');
    expect(manifestAfterMiss.checksums['countries/IN.json']).toBe(initialInHash);

    // 8. Assert manifest.cache.json accurately tracks IN.cache.json
    const cacheManifest: PipelineManifest = JSON.parse(
      fs.readFileSync(exporter.getCacheManifestFilePath(), 'utf8')
    );
    expect(cacheManifest.source).toBe('google-maps');
    expect(cacheManifest.checksums['countries/IN.cache.json']).toBe(
      await LocationExporter.calculateFileChecksum(inCachePath)
    );

    // 9. Second lookup: served from warm cache with no additional API calls
    const res2 = await cacheService.lookup('Cyber City Gurugram', 'IN');
    expect(res2.status).toBe('HIT');
    expect(res2.fromCache).toBe(true);
    expect(res2.record?.name).toBe('Cyber City Gurugram');
    expect(apiSpy).toHaveBeenCalledTimes(1);

    // 10. Cold restart: reinitialize cache service and verify persisted cache entry is used
    const coldCacheService = new LocationCacheService({
      apiClient: mockApiClient,
      exporter,
      cacheTtlDays: 30
    });
    await coldCacheService.initCache();

    const res3 = await coldCacheService.lookup('Cyber City Gurugram', 'IN');
    expect(res3.status).toBe('HIT');
    expect(res3.fromCache).toBe(true);
    expect(res3.record?.name).toBe('Cyber City Gurugram');
    expect(res3.record?.source).toBe('google-maps');
    expect(apiSpy).toHaveBeenCalledTimes(1); // Call count still exactly 1 across entire lifecycle!
  });

  it('Task 2: Concurrent Google cache writes for distinct India locations (mutex serialization, zero loss, valid JSON)', async () => {
    // 1. Setup isolated bulk environment (> 5 MB)
    const inJsonPath = exporter.getCountryFilePath('IN');
    const citiesPath = exporter.getIndiaCitiesFilePath();
    const statesPath = exporter.getIndiaStatesFilePath();
    fs.mkdirSync(path.dirname(inJsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(citiesPath), { recursive: true });
    fs.mkdirSync(path.dirname(statesPath), { recursive: true });

    const padding = ' '.repeat(6 * 1024 * 1024);
    fs.writeFileSync(inJsonPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');
    fs.writeFileSync(citiesPath, `[\n  ${JSON.stringify(mockBulkIndiaRecord)}${padding}\n]`, 'utf8');
    fs.writeFileSync(statesPath, '[]', 'utf8');

    const bulkManifest: PipelineManifest = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: 'geonames',
      license: 'Creative Commons Attribution 4.0 International (CC-BY 4.0)',
      attribution: 'GeoNames (geonames.org)',
      totalRecords: 1,
      countryCoverage: [{ code: 'IN', name: 'India', recordCount: 1 }],
      status: 'completed',
      checksums: {
        'countries/IN.json': await LocationExporter.calculateFileChecksum(inJsonPath),
        'india/cities.json': await LocationExporter.calculateFileChecksum(citiesPath)
      }
    };
    await exporter.writeManifest(bulkManifest);

    const initialInHash = bulkManifest.checksums['countries/IN.json'];
    const initialCitiesHash = bulkManifest.checksums['india/cities.json'];

    // 2. Define 5 distinct Indian locations not present in local GeoNames
    const distinctLocations: LocationRecord[] = [
      {
        ...mockGoogleIndiaRecord,
        id: 'ChIJ_Location_1',
        name: 'Cyber City Gurugram',
        asciiName: 'Cyber City Gurugram'
      },
      {
        ...mockGoogleIndiaRecord,
        id: 'ChIJ_Location_2',
        name: 'Whitefield Tech Zone',
        asciiName: 'Whitefield Tech Zone'
      },
      {
        ...mockGoogleIndiaRecord,
        id: 'ChIJ_Location_3',
        name: 'BKC Financial Center',
        asciiName: 'BKC Financial Center'
      },
      {
        ...mockGoogleIndiaRecord,
        id: 'ChIJ_Location_4',
        name: 'HITEC Innovation Hub',
        asciiName: 'HITEC Innovation Hub'
      },
      {
        ...mockGoogleIndiaRecord,
        id: 'ChIJ_Location_5',
        name: 'Salt Lake IT Park',
        asciiName: 'Salt Lake IT Park'
      }
    ];

    // 3. Mock API client with simulated overlapping async delay (15-35ms)
    const apiSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockImplementation(async (cityName) => {
      await new Promise((resolve) => setTimeout(resolve, 15 + Math.random() * 20));
      const match = distinctLocations.find((r) => r.name.toLowerCase() === cityName.toLowerCase());
      return match || null;
    });

    // 4. Fire 5 simultaneous cache misses for distinct Indian locations
    const promises = distinctLocations.map((loc) => cacheService.lookup(loc.name, 'IN'));
    const results = await Promise.all(promises);

    // 5. Verify each lookup returned the correct location record
    expect(results.length).toBe(5);
    for (let i = 0; i < distinctLocations.length; i++) {
      expect(results[i].status).toBe('MISS');
      expect(results[i].fromCache).toBe(false);
      expect(results[i].record?.name).toBe(distinctLocations[i].name);
      expect(results[i].record?.id).toBe(distinctLocations[i].id);
    }
    expect(apiSpy).toHaveBeenCalledTimes(5);

    // 6. Verify all 5 records persist in IN.cache.json without any lost records
    const inCachePath = path.join(exporter.getCountriesDir(), 'IN.cache.json');
    expect(fs.existsSync(inCachePath)).toBe(true);

    const savedCacheRecords: LocationRecord[] = JSON.parse(fs.readFileSync(inCachePath, 'utf8'));
    expect(savedCacheRecords.length).toBe(5);

    const savedNames = savedCacheRecords.map((r) => r.name).sort();
    const expectedNames = distinctLocations.map((r) => r.name).sort();
    expect(savedNames).toEqual(expectedNames);

    // 7. Verify JSON file on disk is syntactically valid and can be loaded on cold restart
    const coldCache = new LocationCacheService({
      apiClient: mockApiClient,
      exporter,
      cacheTtlDays: 30
    });
    const loadedCount = await coldCache.initCache();
    expect(loadedCount).toBe(5);

    for (const loc of distinctLocations) {
      const coldLookup = await coldCache.lookup(loc.name, 'IN');
      expect(coldLookup.status).toBe('HIT');
      expect(coldLookup.fromCache).toBe(true);
      expect(coldLookup.record?.id).toBe(loc.id);
    }
    // No new API calls made during cold lookups!
    expect(apiSpy).toHaveBeenCalledTimes(5);

    // 8. Verify cache manifest metadata remains valid and consistent with final cache file
    const cacheManifestPath = exporter.getCacheManifestFilePath();
    expect(fs.existsSync(cacheManifestPath)).toBe(true);
    const cacheManifest: PipelineManifest = JSON.parse(fs.readFileSync(cacheManifestPath, 'utf8'));
    expect(cacheManifest.source).toBe('google-maps');
    expect(cacheManifest.totalRecords).toBe(5);
    const finalCacheHash = await LocationExporter.calculateFileChecksum(inCachePath);
    expect(cacheManifest.checksums['countries/IN.cache.json']).toBe(finalCacheHash);

    // 9. Verify bulk dataset files and manifest.json remain completely untouched
    const bulkInRecords: LocationRecord[] = JSON.parse(fs.readFileSync(inJsonPath, 'utf8'));
    expect(bulkInRecords.length).toBe(1);
    expect(bulkInRecords[0].name).toBe('Hyderabad');
    expect(await LocationExporter.calculateFileChecksum(inJsonPath)).toBe(initialInHash);
    expect(await LocationExporter.calculateFileChecksum(citiesPath)).toBe(initialCitiesHash);

    const bulkManifestAfter: PipelineManifest = JSON.parse(
      fs.readFileSync(exporter.getManifestFilePath(), 'utf8')
    );
    expect(bulkManifestAfter.source).toBe('geonames');
    expect(bulkManifestAfter.checksums['countries/IN.json']).toBe(initialInHash);
    expect(bulkManifestAfter.checksums['india/cities.json']).toBe(initialCitiesHash);
  });
});
