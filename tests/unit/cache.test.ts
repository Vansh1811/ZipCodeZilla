import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationCacheService } from '../../src/cache/index.js';
import { GoogleMapsApiClient } from '../../src/apiClient/index.js';
import { LocationExporter } from '../../src/exporter/index.js';
import type { LocationRecord } from '../../src/types.js';

describe('LocationCacheService — API-Based Caching & Refresh', () => {
  let tempDir: string;
  let exporter: LocationExporter;
  let mockApiClient: GoogleMapsApiClient;
  let cacheService: LocationCacheService;

  const mockMumbaiRecord: LocationRecord = {
    id: 'ChIJwe1EZjDG5zsRaYxkjY_tpF0',
    name: 'Mumbai',
    asciiName: 'Mumbai',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: 'MH',
    admin1Name: 'Maharashtra',
    admin2Code: 'Mumbai City',
    featureClass: 'P',
    featureCode: 'PPL',
    latitude: 18.9582,
    longitude: 72.8319,
    timezone: 'Asia/Kolkata',
    population: null,
    elevation: null,
    modificationDate: '2024-01-01',
    source: 'google-maps',
    updatedAt: new Date().toISOString()
  };

  const mockDelhiRecord: LocationRecord = {
    id: 'ChIJLbZ-NFv9DDkRzk0gTkm3wlI',
    name: 'New Delhi',
    asciiName: 'New Delhi',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: 'DL',
    admin1Name: 'Delhi',
    admin2Code: null,
    featureClass: 'P',
    featureCode: 'PPLC',
    latitude: 28.6139,
    longitude: 77.2088,
    timezone: 'Asia/Kolkata',
    population: null,
    elevation: null,
    modificationDate: '2024-01-01',
    source: 'google-maps',
    updatedAt: new Date().toISOString()
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
    exporter = new LocationExporter(tempDir);

    // Mock API client with controllable request counter
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

  // Test A — Initial cache miss
  it('Test A: Initial cache miss calls API and saves validated record to JSON file', async () => {
    const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockMumbaiRecord);

    const result = await cacheService.lookup('Mumbai', 'IN');

    expect(result.status).toBe('MISS');
    expect(result.fromCache).toBe(false);
    expect(result.record).toEqual(mockMumbaiRecord);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Verify written to disk JSON file
    const inJsonPath = exporter.getCountryFilePath('IN');
    expect(fs.existsSync(inJsonPath)).toBe(true);
    const savedRecords: LocationRecord[] = JSON.parse(fs.readFileSync(inJsonPath, 'utf8'));
    expect(savedRecords.length).toBe(1);
    expect(savedRecords[0].name).toBe('Mumbai');

    // Verify India cities partition updated
    const indiaCitiesPath = exporter.getIndiaCitiesFilePath();
    expect(fs.existsSync(indiaCitiesPath)).toBe(true);
  });

  // Test B — Repeated lookup (Cache HIT)
  it('Test B: Repeated lookup returns cached record and does NOT call API again', async () => {
    const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockMumbaiRecord);

    // First lookup (MISS)
    const firstResult = await cacheService.lookup('Mumbai', 'IN');
    expect(firstResult.status).toBe('MISS');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second lookup for exact same location (HIT)
    const secondResult = await cacheService.lookup('Mumbai', 'IN');
    expect(secondResult.status).toBe('HIT');
    expect(secondResult.fromCache).toBe(true);
    expect(secondResult.record?.id).toBe(mockMumbaiRecord.id);

    // PROOF: API request count did NOT increase on cache hit
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // Test C — Different location
  it('Test C: Different locations use distinct cache keys and do not collide', async () => {
    const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockImplementation(async (city) => {
      if (city === 'Mumbai') return mockMumbaiRecord;
      if (city === 'New Delhi') return mockDelhiRecord;
      return null;
    });

    const res1 = await cacheService.lookup('Mumbai', 'IN');
    const res2 = await cacheService.lookup('New Delhi', 'IN');

    expect(res1.record?.name).toBe('Mumbai');
    expect(res2.record?.name).toBe('New Delhi');
    expect(res1.cacheKey).toBe('IN:mumbai');
    expect(res2.cacheKey).toBe('IN:new delhi');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Re-querying both hits cache
    await cacheService.lookup('Mumbai', 'IN');
    await cacheService.lookup('New Delhi', 'IN');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // Test D — Cache freshness
  it('Test D: Fresh record does not trigger API; Expired record refreshes according to policy', async () => {
    // 1. Fresh record
    vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockMumbaiRecord);
    await cacheService.lookup('Mumbai', 'IN');

    // 2. Simulate expired record by back-dating updatedAt to 40 days ago (TTL is 30 days)
    const staleMumbai: LocationRecord = {
      ...mockMumbaiRecord,
      updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    };
    await exporter.upsertCountryRecord(staleMumbai);
    cacheService.clearInMemoryCache();
    await cacheService.initCache();

    // Setup updated return for refresh
    const refreshedMumbai: LocationRecord = {
      ...mockMumbaiRecord,
      timezone: 'Asia/Kolkata',
      updatedAt: new Date().toISOString()
    };
    const refreshSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(refreshedMumbai);

    // Lookup expired record
    const result = await cacheService.lookup('Mumbai', 'IN');

    expect(result.status).toBe('EXPIRED');
    expect(result.refreshed).toBe(true);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(cacheService.isFresh(result.record!)).toBe(true);
  });

  // Test E — API failure handling & data protection
  it('Test E: API failure does not corrupt existing cache and returns meaningful error', async () => {
    // Seed cache with valid record
    await exporter.upsertCountryRecord(mockMumbaiRecord);
    await cacheService.initCache();

    // Stale Mumbai that fails to refresh
    const staleMumbai: LocationRecord = {
      ...mockMumbaiRecord,
      updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    };
    await exporter.upsertCountryRecord(staleMumbai);
    cacheService.clearInMemoryCache();

    // Mock API error (HTTP 500 / timeout)
    vi.spyOn(mockApiClient, 'fetchLocation').mockRejectedValue(new Error('HTTP 500 Internal Server Error'));

    const result = await cacheService.lookup('Mumbai', 'IN');

    // Stale record returned gracefully to prevent application crash
    expect(result.record).toBeDefined();
    expect(result.record?.name).toBe('Mumbai');
    expect(result.error).toContain('Refresh failed');

    // Verify disk data was NOT corrupted
    const savedRecords = exporter.loadCountryRecords('IN');
    expect(savedRecords.length).toBe(1);
    expect(savedRecords[0].name).toBe('Mumbai');
  });

  // Test F — Cron refresh
  it('Test F: Cron refresh processes only eligible stale records and skips fresh records', async () => {
    // Fresh Delhi record
    const freshDelhi: LocationRecord = {
      ...mockDelhiRecord,
      updatedAt: new Date().toISOString()
    };

    // Stale Mumbai record (50 days old)
    const staleMumbai: LocationRecord = {
      ...mockMumbaiRecord,
      updatedAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString()
    };

    await exporter.upsertCountryRecord(freshDelhi);
    await exporter.upsertCountryRecord(staleMumbai);
    await cacheService.initCache();

    const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue({
      ...staleMumbai,
      updatedAt: new Date().toISOString()
    });

    const refreshReport = await cacheService.refreshStaleRecords();

    expect(refreshReport.checked).toBe(2);
    expect(refreshReport.refreshed).toBe(1); // Only Mumbai refreshed
    expect(refreshReport.skipped).toBe(1);   // Fresh Delhi skipped
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // Test G — Concurrent request coalescing (Singleflight)
  it('Test G: Concurrent identical cache misses coalesce into a single API call', async () => {
    let callCount = 0;
    vi.spyOn(mockApiClient, 'fetchLocation').mockImplementation(async () => {
      callCount++;
      // Simulate 50ms async network latency
      await new Promise((resolve) => setTimeout(resolve, 50));
      return mockMumbaiRecord;
    });

    // Fire 5 simultaneous lookups for the exact same uncached location
    const promises = [
      cacheService.lookup('Mumbai', 'IN'),
      cacheService.lookup('Mumbai', 'IN'),
      cacheService.lookup('Mumbai', 'IN'),
      cacheService.lookup('Mumbai', 'IN'),
      cacheService.lookup('Mumbai', 'IN')
    ];

    const results = await Promise.all(promises);

    // All 5 returned valid records
    for (const res of results) {
      expect(res.record?.name).toBe('Mumbai');
    }

    // Singleflight verified: Only 1 API call was executed across all 5 concurrent requests!
    expect(callCount).toBe(1);
  });

  // Test H — Scheduled cache maintenance pruning (Google ToS compliance)
  it('Test H: Permitted maintenance pruneExpiredRecords() removes records older than 30 days with 0 external API calls', async () => {
    // 1. Fresh Delhi record (today)
    const freshDelhi: LocationRecord = {
      ...mockDelhiRecord,
      updatedAt: new Date().toISOString()
    };

    // 2. Stale Mumbai record (45 days old, exceeds 30-day Google ToS limit)
    const staleMumbai: LocationRecord = {
      ...mockMumbaiRecord,
      updatedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
    };

    await exporter.upsertCountryRecord(freshDelhi);
    await exporter.upsertCountryRecord(staleMumbai);
    await cacheService.initCache();

    // Spy on API client to prove ZERO external API calls are made during scheduled maintenance
    const apiSpy = vi.spyOn(mockApiClient, 'fetchLocation');

    // Execute permitted maintenance
    const report = await cacheService.pruneExpiredRecords();

    expect(report.checked).toBe(2);
    expect(report.pruned).toBe(1);   // Stale Mumbai pruned
    expect(report.retained).toBe(1); // Fresh Delhi retained
    expect(apiSpy).toHaveBeenCalledTimes(0); // PROOF: Zero unprompted API calls!

    // Verify in-memory index
    expect(cacheService.getRecordById(mockMumbaiRecord.id)).toBeNull();
    expect(cacheService.getRecordById(mockDelhiRecord.id)).not.toBeNull();

    // Verify persisted JSON file on disk
    const savedRecords = exporter.loadCountryRecords('IN');
    expect(savedRecords.length).toBe(1);
    expect(savedRecords[0].name).toBe('New Delhi');
  });
});
