import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalGeoNamesResolver,
  normalizeLocationName,
  rankCandidates,
  getFeatureScore
} from '../../src/cache/localResolver.js';
import { LocationCacheService } from '../../src/cache/index.js';
import { GoogleMapsApiClient } from '../../src/apiClient/index.js';
import { LocationExporter } from '../../src/exporter/index.js';
import type { LocationRecord } from '../../src/types.js';

describe('Local GeoNames Resolver & Resolution Order Integration', () => {
  let tempDir: string;
  let exporter: LocationExporter;
  let mockApiClient: GoogleMapsApiClient;
  let localResolver: LocalGeoNamesResolver;
  let cacheService: LocationCacheService;

  const mockMumbaiGeoNames: LocationRecord = {
    id: '1275339',
    name: 'Mumbai',
    asciiName: 'Mumbai',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: '16',
    admin1Name: 'Maharashtra',
    admin2Code: '519',
    featureClass: 'P',
    featureCode: 'PPLA',
    latitude: 19.07283,
    longitude: 72.88261,
    timezone: 'Asia/Kolkata',
    population: 12691836,
    elevation: 8,
    modificationDate: '2024-01-01',
    source: 'geonames',
    updatedAt: new Date().toISOString()
  };

  const mockDelhiCapital: LocationRecord = {
    id: '1273294',
    name: 'Delhi',
    asciiName: 'Delhi',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: '07',
    admin1Name: 'Delhi',
    admin2Code: null,
    featureClass: 'P',
    featureCode: 'PPLA',
    latitude: 28.65195,
    longitude: 77.23149,
    timezone: 'Asia/Kolkata',
    population: 11034555,
    elevation: null,
    modificationDate: '2024-01-01',
    source: 'geonames',
    updatedAt: new Date().toISOString()
  };

  const mockDelhiVillage: LocationRecord = {
    id: '9999991',
    name: 'Delhi',
    asciiName: 'Delhi',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: '23',
    admin1Name: 'Punjab',
    admin2Code: null,
    featureClass: 'P',
    featureCode: 'PPL',
    latitude: 31.0,
    longitude: 75.0,
    timezone: 'Asia/Kolkata',
    population: 500,
    elevation: null,
    modificationDate: '2024-01-01',
    source: 'geonames',
    updatedAt: new Date().toISOString()
  };

  const mockMaharashtraState: LocationRecord = {
    id: '1264418',
    name: 'State of Mahārāshtra',
    asciiName: 'State of Maharashtra',
    countryCode: 'IN',
    countryName: 'India',
    admin1Code: '16',
    admin1Name: 'Maharashtra',
    admin2Code: null,
    featureClass: 'A',
    featureCode: 'ADM1',
    latitude: 19.5,
    longitude: 76.0,
    timezone: 'Asia/Kolkata',
    population: 112374333,
    elevation: null,
    modificationDate: '2024-01-01',
    source: 'geonames',
    updatedAt: new Date().toISOString()
  };

  const mockGoogleTokyo: LocationRecord = {
    id: 'ChIJ513GhRequestTokyoId',
    name: 'Tokyo',
    asciiName: 'Tokyo',
    countryCode: 'JP',
    countryName: 'Japan',
    admin1Code: '13',
    admin1Name: 'Tokyo',
    admin2Code: null,
    featureClass: null,
    featureCode: null,
    latitude: 35.6762,
    longitude: 139.6503,
    timezone: 'Asia/Tokyo',
    population: null,
    elevation: null,
    modificationDate: null,
    source: 'google-maps',
    updatedAt: new Date().toISOString()
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'));
    exporter = new LocationExporter(tempDir);

    // Populate local mock datasets under tempDir/india/
    const indiaDir = path.join(tempDir, 'india');
    fs.mkdirSync(indiaDir, { recursive: true });

    // Write cities.json
    fs.writeFileSync(
      path.join(indiaDir, 'cities.json'),
      JSON.stringify([mockMumbaiGeoNames, mockDelhiVillage, mockDelhiCapital], null, 2),
      'utf8'
    );

    // Write states.json
    fs.writeFileSync(
      path.join(indiaDir, 'states.json'),
      JSON.stringify([mockMaharashtraState], null, 2),
      'utf8'
    );

    mockApiClient = new GoogleMapsApiClient({
      apiKey: 'test-key',
      apiBaseUrl: 'https://fake-maps'
    });

    localResolver = new LocalGeoNamesResolver({ dataDir: tempDir });
    cacheService = new LocationCacheService({
      apiClient: mockApiClient,
      exporter,
      localResolver,
      cacheTtlDays: 30
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('LocalGeoNamesResolver Unit Tests', () => {
    it('normalizes diacritics and case cleanly', () => {
      expect(normalizeLocationName('Mahārāshtra')).toBe('maharashtra');
      expect(normalizeLocationName('  MUMBAI  ')).toBe('mumbai');
      expect(normalizeLocationName('Ganga Sāgar')).toBe('ganga sagar');
    });

    it('ranks candidates by feature code prominence and population', () => {
      expect(getFeatureScore('PPLC')).toBe(100);
      expect(getFeatureScore('PPLA')).toBe(90);
      expect(getFeatureScore('PPL')).toBe(50);

      // Delhi capital (PPLA, pop 11M) vs Delhi village (PPL, pop 500)
      const ranked = rankCandidates([mockDelhiVillage, mockDelhiCapital], 'Delhi');
      expect(ranked.id).toBe(mockDelhiCapital.id);
      expect(ranked.population).toBe(11034555);
      expect(ranked.featureCode).toBe('PPLA');
    });

    it('resolves city from local cities.json stream with 0 API calls', async () => {
      const result = await localResolver.findLocation('Mumbai', 'IN');
      expect(result).not.toBeNull();
      expect(result?.id).toBe(mockMumbaiGeoNames.id);
      expect(result?.name).toBe('Mumbai');
      expect(result?.source).toBe('geonames');
    });

    it('resolves state from local states.json index', async () => {
      const result = await localResolver.findLocation('Maharashtra', 'IN');
      expect(result).not.toBeNull();
      expect(result?.name).toBe('State of Mahārāshtra');
      expect(result?.admin1Name).toBe('Maharashtra');
      expect(result?.featureCode).toBe('ADM1');
    });

    it('enforces country filter and ignores local India data when foreign country requested', async () => {
      // Searching for "Mumbai" in country "US" must NOT return India's Mumbai
      const result = await localResolver.findLocation('Mumbai', 'US');
      expect(result).toBeNull();
    });

    it('returns null and caches negative result for non-existent locations', async () => {
      const result = await localResolver.findLocation('AtlantisNonExistent', 'IN');
      expect(result).toBeNull();

      // Second check hits negative cache directly
      const result2 = await localResolver.findLocation('AtlantisNonExistent', 'IN');
      expect(result2).toBeNull();
    });
  });

  describe('LocationCacheService Strict Resolution Order Tests', () => {
    it('Rule 1: Local GeoNames HIT makes ZERO Google API calls', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation');

      const result = await cacheService.lookup('Mumbai', 'IN');

      expect(result.status).toBe('HIT');
      expect(result.fromCache).toBe(true);
      expect(result.refreshed).toBe(false);
      expect(result.record?.id).toBe(mockMumbaiGeoNames.id);
      expect(result.record?.source).toBe('geonames');

      // VERIFICATION: Zero Google API requests executed
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    it('Rule 2: Ambiguous name resolves the principal city (capital/metropolis)', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation');

      const result = await cacheService.lookup('Delhi', 'IN');

      expect(result.status).toBe('HIT');
      expect(result.fromCache).toBe(true);
      expect(result.record?.id).toBe(mockDelhiCapital.id);
      expect(result.record?.admin1Code).toBe('07'); // Delhi state, not Punjab village
      expect(result.record?.population).toBe(11034555);

      expect(fetchSpy).toHaveBeenCalledTimes(0);
    });

    it('Rule 3: Genuine Google cache HIT returns cached record and avoids API call', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockGoogleTokyo);

      // 1. Initial lookup -> MISS -> Calls Google API once
      const missResult = await cacheService.lookup('Tokyo', 'JP');
      expect(missResult.status).toBe('MISS');
      expect(missResult.fromCache).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // 2. Subsequent lookup -> HIT from Google cache -> ZERO additional API calls
      const hitResult = await cacheService.lookup('Tokyo', 'JP');
      expect(hitResult.status).toBe('HIT');
      expect(hitResult.fromCache).toBe(true);
      expect(hitResult.record?.id).toBe(mockGoogleTokyo.id);

      // API count remains 1
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('Rule 4: Cache MISS calls Google API only when necessary', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockGoogleTokyo);

      // Looking up a Japanese city (not in local India GeoNames, not yet in cache)
      const result = await cacheService.lookup('Tokyo', 'JP');

      expect(result.status).toBe('MISS');
      expect(result.record?.name).toBe('Tokyo');
      expect(result.record?.source).toBe('google-maps');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('Rule 5: Unknown locations where Google returns ZERO_RESULTS return VALID_EMPTY cleanly', async () => {
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(null);

      const result = await cacheService.lookup('NonExistentPlace999', 'US');

      expect(result.status).toBe('VALID_EMPTY');
      expect(result.record).toBeNull();
      expect(result.fromCache).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('Rule 6: Country filter prevents incorrect local matches', async () => {
      const mockUSLocation: LocationRecord = {
        ...mockMumbaiGeoNames,
        id: 'ChIJ_US_Mumbai',
        name: 'Mumbai',
        countryCode: 'US',
        countryName: 'United States',
        source: 'google-maps'
      };
      const fetchSpy = vi.spyOn(mockApiClient, 'fetchLocation').mockResolvedValue(mockUSLocation);

      // Query Mumbai with US filter: must NOT return Indian Mumbai from local dataset
      const result = await cacheService.lookup('Mumbai', 'US');

      expect(result.record?.countryCode).toBe('US');
      expect(result.record?.source).toBe('google-maps');
      // Proves that local India dataset was bypassed and Google API was called for the US query
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('Rule 7: Input validation handles empty names and malformed country codes', async () => {
      const resEmpty = await cacheService.lookup('   ', 'IN');
      expect(resEmpty.status).toBe('VALID_EMPTY');
      expect(resEmpty.error).toMatch(/empty/i);

      const resBadCountry = await cacheService.lookup('Paris', 'USA'); // 3 letters instead of 2
      expect(resBadCountry.status).toBe('VALID_EMPTY');
      expect(resBadCountry.error).toMatch(/2-letter ISO/i);
    });
  });
});
