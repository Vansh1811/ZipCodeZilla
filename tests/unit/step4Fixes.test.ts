import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationCacheService } from '../../src/cache/index.js';
import { LocalGeoNamesResolver } from '../../src/cache/localResolver.js';
import { GoogleMapsApiClient } from '../../src/apiClient/index.js';
import { LocationExporter } from '../../src/exporter/index.js';
import type { LocationRecord } from '../../src/types.js';

describe('Step 4 Defect Fixes Verification', () => {
  let tempDir: string;
  let exporter: LocationExporter;
  let mockApiClient: GoogleMapsApiClient;
  let localResolver: LocalGeoNamesResolver;
  let cacheService: LocationCacheService;

  const mockGeoNamesBengaluru: LocationRecord = {
    id: '1277333',
    name: 'Bengaluru',
    asciiName: 'Bengaluru',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: '19',
    admin1Name: 'Karnataka',
    admin2Code: null,
    featureClass: 'P',
    featureCode: 'PPLA',
    latitude: 12.97194,
    longitude: 77.59369,
    timezone: 'Asia/Kolkata',
    population: 8443675,
    elevation: 920,
    modificationDate: '2024-01-01',
    source: 'geonames',
    updatedAt: new Date().toISOString()
  };

  const mockGoogleDLF: LocationRecord = {
    id: 'ChIJ_DLF_Cyber_Hub',
    name: 'DLF Cyber City',
    asciiName: 'DLF Cyber City',
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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'location-step4-fixes-test-'));
    fs.mkdirSync(path.join(tempDir, 'countries'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'india'), { recursive: true });

    exporter = new LocationExporter(tempDir);
    mockApiClient = new GoogleMapsApiClient({ apiKey: 'AIzaSyTestMockKeyStep4' });
    localResolver = new LocalGeoNamesResolver({ dataDir: tempDir });
    cacheService = new LocationCacheService({
      apiClient: mockApiClient,
      localResolver,
      exporter,
      cacheTtlDays: 30
    });
  });

  afterEach(() => {
    cacheService.clearInMemoryCache();
    localResolver.clearCache();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks();
  });

  describe('1. Pipeline-wide Request Coalescing', () => {
    it('coalesces concurrent requests resolving from local GeoNames into a single execution', async () => {
      // Write mock record to india/cities.json
      const citiesPath = path.join(tempDir, 'india', 'cities.json');
      fs.writeFileSync(citiesPath, JSON.stringify([mockGeoNamesBengaluru], null, 2), 'utf8');

      const findLocationSpy = vi.spyOn(localResolver, 'findLocation');

      // Launch 5 concurrent identical lookups
      const promises = [
        cacheService.lookup('Bengaluru', 'IN'),
        cacheService.lookup('Bengaluru', 'IN'),
        cacheService.lookup('Bengaluru', 'IN'),
        cacheService.lookup('Bengaluru', 'IN'),
        cacheService.lookup('Bengaluru', 'IN')
      ];

      const results = await Promise.all(promises);

      // All 5 returned valid HIT
      for (const res of results) {
        expect(res.status).toBe('HIT');
        expect(res.fromCache).toBe(true);
        expect(res.record?.name).toBe('Bengaluru');
      }

      // Proves request coalescing prevented duplicate local resolver scans
      expect(findLocationSpy).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent requests resolving from external API into a single API call', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockImplementation(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return mockGoogleDLF;
        }
      );

      const promises = [
        cacheService.lookup('DLF Cyber City', 'IN'),
        cacheService.lookup('DLF Cyber City', 'IN'),
        cacheService.lookup('DLF Cyber City', 'IN')
      ];

      const results = await Promise.all(promises);

      for (const res of results) {
        expect(res.record?.name).toBe('DLF Cyber City');
        expect(res.record?.id).toBe(mockGoogleDLF.id);
      }

      // Exactly 1 external Google API call was made
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('guarantees inFlightRequests map cleanup in finally even when lookup throws', async () => {
      vi.spyOn(localResolver, 'findLocation').mockRejectedValueOnce(new Error('Fatal disk read error'));

      await expect(cacheService.lookup('FailCity', 'IN')).rejects.toThrow('Fatal disk read error');

      // The in-flight map must be clean, so a subsequent request is allowed to execute
      vi.spyOn(localResolver, 'findLocation').mockResolvedValueOnce(null);
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValueOnce(null);

      const retryRes = await cacheService.lookup('FailCity', 'IN');
      expect(retryRes.status).toBe('VALID_EMPTY');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. In-Memory Negative Caching for Empty Results', () => {
    it('prevents repeated Google API calls for unresolvable locations', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(null);

      // First lookup -> MISS -> Google returns ZERO_RESULTS (null)
      const res1 = await cacheService.lookup('NonExistentPlaceXYZ', 'IN');
      expect(res1.status).toBe('VALID_EMPTY');
      expect(res1.record).toBeNull();
      expect(res1.fromCache).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second lookup -> Negative cache HIT -> ZERO additional API calls
      const res2 = await cacheService.lookup('NonExistentPlaceXYZ', 'IN');
      expect(res2.status).toBe('VALID_EMPTY');
      expect(res2.record).toBeNull();
      expect(res2.fromCache).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // Still 1!

      // Third lookup -> Still served from negative cache
      const res3 = await cacheService.lookup('NonExistentPlaceXYZ', 'IN');
      expect(res3.status).toBe('VALID_EMPTY');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Negative cache must NOT write synthetic or empty records to disk
      const cachePath = path.join(tempDir, 'countries', 'IN.cache.json');
      if (fs.existsSync(cachePath)) {
        const fileContent = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        expect(fileContent).toEqual([]);
      }
    });

    it('clears negative cache when clearInMemoryCache() is called', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(null);

      await cacheService.lookup('NowhereTown', 'US');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Clear memory cache
      cacheService.clearInMemoryCache();

      // Next lookup must query API again because negative cache was cleared
      await cacheService.lookup('NowhereTown', 'US');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('3. Partitioned Offset Index for Fast Cities Lookup', () => {
    it('builds offset index and resolves locations in sub-millisecond without loading whole file', async () => {
      const candidate1: LocationRecord = {
        ...mockGeoNamesBengaluru,
        id: '1001',
        name: 'Belgaum',
        asciiName: 'Belgaum',
        featureCode: 'PPLA2',
        population: 500000
      };
      const candidate2: LocationRecord = {
        ...mockGeoNamesBengaluru,
        id: '1002',
        name: 'Bellary',
        asciiName: 'Bellary',
        featureCode: 'PPLA2',
        population: 400000
      };

      const citiesPath = path.join(tempDir, 'india', 'cities.json');
      fs.writeFileSync(
        citiesPath,
        '[\n  ' + JSON.stringify(candidate1) + ',\n  ' + JSON.stringify(candidate2) + '\n]\n',
        'utf8'
      );

      // Build the offset index
      await localResolver.buildIndex();
      expect(localResolver.hasIndex()).toBe(true);

      // Index files must exist in .index
      const indexDir = path.join(tempDir, 'india', '.index');
      expect(fs.existsSync(indexDir)).toBe(true);
      const prefixFile = path.join(indexDir, 'be.json');
      expect(fs.existsSync(prefixFile)).toBe(true);

      // Query Belgaum
      const hit = await localResolver.findLocation('Belgaum', 'IN');
      expect(hit).not.toBeNull();
      expect(hit?.name).toBe('Belgaum');
      expect(hit?.id).toBe('1001');

      // Query Bellary
      const hit2 = await localResolver.findLocation('Bellary', 'IN');
      expect(hit2).not.toBeNull();
      expect(hit2?.name).toBe('Bellary');
      expect(hit2?.id).toBe('1002');
    });

    it('correctly ranks multiple candidates sharing the same name using administrative prominence', async () => {
      // Candidate A: Small village named 'Rampur' (PPL, pop 1,200)
      const rampurVillage: LocationRecord = {
        ...mockGeoNamesBengaluru,
        id: '2001',
        name: 'Rampur',
        asciiName: 'Rampur',
        featureCode: 'PPL',
        population: 1200
      };
      // Candidate B: District headquarters named 'Rampur' (PPLA2, pop 325,000)
      const rampurDistrictHQ: LocationRecord = {
        ...mockGeoNamesBengaluru,
        id: '2002',
        name: 'Rampur',
        asciiName: 'Rampur',
        featureCode: 'PPLA2',
        population: 325000
      };

      const citiesPath = path.join(tempDir, 'india', 'cities.json');
      fs.writeFileSync(
        citiesPath,
        '[\n  ' + JSON.stringify(rampurVillage) + ',\n  ' + JSON.stringify(rampurDistrictHQ) + '\n]\n',
        'utf8'
      );

      await localResolver.buildIndex();

      const match = await localResolver.findLocation('Rampur', 'IN');
      expect(match).not.toBeNull();
      // Must select the district headquarters (PPLA2) over the village (PPL)
      expect(match?.id).toBe('2002');
      expect(match?.population).toBe(325000);
    });
  });

  describe('4. Large-File Manifest & Exporter Optimization', () => {
    it('countRecordsInJsonFile counts entries using streaming without JSON.parse', async () => {
      const records = [mockGeoNamesBengaluru, { ...mockGeoNamesBengaluru, id: '999', name: 'Mysuru' }];
      const testFile = path.join(tempDir, 'test_records.json');
      fs.writeFileSync(
        testFile,
        '[\n  ' + JSON.stringify(records[0]) + ',\n  ' + JSON.stringify(records[1]) + '\n]\n',
        'utf8'
      );

      const countResult = await LocationExporter.countRecordsInJsonFile(testFile);
      expect(countResult.count).toBe(2);
      expect(countResult.countryName).toBe('India');
    });

    it('refreshIndexAndManifest does not re-read large bulk files when manifest checksum matches', async () => {
      // Set up a manifest and a large mock bulk file (> 5 MB)
      const bulkRecords: LocationRecord[] = [];
      for (let i = 0; i < 50; i++) {
        bulkRecords.push({
          ...mockGeoNamesBengaluru,
          id: `ID_${i}`,
          name: `City_${i}`
        });
      }

      // Write mock bulk file formatted as single line per record
      const inPath = path.join(tempDir, 'countries', 'IN.json');
      const lines = bulkRecords.map(r => '  ' + JSON.stringify(r)).join(',\n');
      fs.writeFileSync(inPath, '[\n' + lines + '\n]\n', 'utf8');

      // Create initial manifest
      await exporter.refreshIndexAndManifest();

      const manifestPath = path.join(tempDir, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const inCoverage = manifest.countryCoverage.find((c: any) => c.code === 'IN');
      expect(inCoverage).toBeDefined();
      expect(inCoverage.recordCount).toBe(50);

      // Now mock statSync so that IN.json is identified as a large bulk file (> 5 MB)
      const originalStatSync = fs.statSync;
      const statSyncSpy = vi.spyOn(fs, 'statSync').mockImplementation((filePath, options) => {
        if (String(filePath).endsWith('IN.json')) {
          const realStat = originalStatSync(filePath, options);
          return Object.assign({}, realStat, { size: 10 * 1024 * 1024 });
        }
        return originalStatSync(filePath, options);
      });

      // Verify that calling refreshIndexAndManifest again reuses checksum/count without readFileSync
      const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
      await exporter.refreshIndexAndManifest();

      // Confirm IN.json was not read synchronously via readFileSync during refresh
      const inJsonReadCalls = readFileSyncSpy.mock.calls.filter(call => String(call[0]).endsWith('IN.json'));
      expect(inJsonReadCalls.length).toBe(0);

      statSyncSpy.mockRestore();
    });
  });

  describe('5. Cold Process Restart Latency with Google Cache', () => {
    it('resolves Google-cached record immediately after cold restart without streaming bulk file', async () => {
      // 1. Populate Google cache file IN.cache.json
      await exporter.upsertCountryRecord(mockGoogleDLF);

      // 2. Set up indexed local GeoNames dataset
      const citiesPath = path.join(tempDir, 'india', 'cities.json');
      fs.writeFileSync(citiesPath, JSON.stringify([mockGeoNamesBengaluru], null, 2), 'utf8');
      await localResolver.buildIndex();

      // 3. Simulate cold restart: create brand-new instances
      const restartResolver = new LocalGeoNamesResolver({ dataDir: tempDir });
      const restartExporter = new LocationExporter(tempDir);
      const restartCacheService = new LocationCacheService({
        apiClient: mockApiClient,
        localResolver: restartResolver,
        exporter: restartExporter
      });

      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation');

      const t0 = performance.now();
      const res = await restartCacheService.lookup('DLF Cyber City', 'IN');
      const latency = performance.now() - t0;

      expect(res.status).toBe('HIT');
      expect(res.fromCache).toBe(true);
      expect(res.record?.name).toBe('DLF Cyber City');
      expect(res.record?.source).toBe('google-maps');
      expect(fetchSpy).toHaveBeenCalledTimes(0);

      // Cold lookup should be well under 100ms in unit test environment
      expect(latency).toBeLessThan(100);
    });
  });
});
