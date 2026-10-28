import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleMapsApiClient, GoogleGeocodeResponse, GoogleTimezoneResponse } from '../../src/apiClient/index.js';

describe('GoogleMapsApiClient', () => {
  let client: GoogleMapsApiClient;

  beforeEach(() => {
    client = new GoogleMapsApiClient({
      apiKey: 'test-fake-key',
      apiBaseUrl: 'https://fake-maps-api',
      maxRetries: 1,
      timeoutMs: 1000
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('correctly maps Google geocode result into canonical LocationRecord', () => {
    const rawGoogleResult = {
      place_id: 'ChIJwe1EZjDG5zsRaYxkjY_tpF0',
      formatted_address: 'Mumbai, Maharashtra, India',
      address_components: [
        { long_name: 'Mumbai', short_name: 'Mumbai', types: ['locality', 'political'] },
        { long_name: 'Maharashtra', short_name: 'MH', types: ['administrative_area_level_1', 'political'] },
        { long_name: 'India', short_name: 'IN', types: ['country', 'political'] }
      ],
      geometry: {
        location: { lat: 18.9582, lng: 72.8319 }
      },
      types: ['locality', 'political']
    };

    const record = client.mapGoogleResult(rawGoogleResult, 'Mumbai', 'IN', 'Asia/Kolkata');

    expect(record.id).toBe('ChIJwe1EZjDG5zsRaYxkjY_tpF0');
    expect(record.name).toBe('Mumbai');
    expect(record.countryCode).toBe('IN');
    expect(record.countryName).toBe('India');
    expect(record.admin1Code).toBe('MH');
    expect(record.admin1Name).toBe('Maharashtra');
    expect(record.latitude).toBeCloseTo(18.9582);
    expect(record.longitude).toBeCloseTo(72.8319);
    expect(record.timezone).toBe('Asia/Kolkata');
    expect(record.featureClass).toBeNull();
    expect(record.featureCode).toBeNull();
    expect(record.population).toBeNull();
    expect(record.elevation).toBeNull();
    expect(record.modificationDate).toBeNull();
    expect(record.types).toEqual(['locality', 'political']);
    expect(record.source).toBe('google-maps');
  });

  it('returns null on ZERO_RESULTS without error', async () => {
    const mockZeroResponse: GoogleGeocodeResponse = {
      status: 'ZERO_RESULTS',
      results: []
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockZeroResponse
    } as any);

    const result = await client.geocodeCity('NonExistentCity12345');
    expect(result).toBeNull();
  });

  it('throws descriptive error on REQUEST_DENIED without excessive retries', async () => {
    const mockDeniedResponse: GoogleGeocodeResponse = {
      status: 'REQUEST_DENIED',
      error_message: 'The provided API key is invalid.',
      results: []
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockDeniedResponse
    } as any);

    await expect(client.geocodeCity('Delhi')).rejects.toThrow('REQUEST_DENIED');
  });

  it('resolves IANA timezone from Google Time Zone API', async () => {
    const mockTimezoneResponse: GoogleTimezoneResponse = {
      status: 'OK',
      timeZoneId: 'Asia/Kolkata',
      timeZoneName: 'India Standard Time'
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockTimezoneResponse
    } as any);

    const tz = await client.getTimezone(18.9582, 72.8319);
    expect(tz).toBe('Asia/Kolkata');
  });
});
