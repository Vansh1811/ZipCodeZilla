import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import type { LocationRecord } from '../types.js';
import { defaultValidator, LocationValidator } from '../validator/index.js';

const logger = createLogger({ module: 'apiClient' });

export interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

export interface GoogleGeocodeResult {
  place_id: string;
  formatted_address: string;
  address_components: GoogleAddressComponent[];
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  types: string[];
}

export interface GoogleGeocodeResponse {
  status: 'OK' | 'ZERO_RESULTS' | 'OVER_QUERY_LIMIT' | 'REQUEST_DENIED' | 'INVALID_REQUEST' | 'UNKNOWN_ERROR';
  error_message?: string;
  results: GoogleGeocodeResult[];
}

export interface GoogleTimezoneResponse {
  status: 'OK' | 'ZERO_RESULTS' | 'OVER_QUERY_LIMIT' | 'REQUEST_DENIED' | 'INVALID_REQUEST' | 'UNKNOWN_ERROR';
  timeZoneId?: string;
  timeZoneName?: string;
  error_message?: string;
}

export interface ApiClientOptions {
  apiKey?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  validator?: LocationValidator;
}

export class GoogleMapsApiClient {
  private apiKey: string;
  private apiBaseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private validator: LocationValidator;
  private requestCount = 0;

  constructor(options?: ApiClientOptions) {
    this.apiKey = options?.apiKey ?? config.apiKey;
    this.apiBaseUrl = options?.apiBaseUrl ?? config.apiBaseUrl;
    this.timeoutMs = options?.timeoutMs ?? config.timeoutMs;
    this.maxRetries = options?.maxRetries ?? config.maxRetries;
    this.validator = options?.validator ?? defaultValidator;
  }

  public getRequestCount(): number {
    return this.requestCount;
  }

  public resetRequestCount(): void {
    this.requestCount = 0;
  }

  /**
   * Geocodes a city using Google Maps Geocoding API.
   */
  public async geocodeCity(cityName: string, countryCode?: string): Promise<GoogleGeocodeResult | null> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key is not configured');
    }

    const params = new URLSearchParams({
      address: cityName,
      key: this.apiKey
    });

    if (countryCode) {
      params.append('components', `country:${countryCode.toUpperCase()}`);
    }

    const url = `${this.apiBaseUrl}/geocode/json?${params.toString()}`;
    const sanitizedLogUrl = `${this.apiBaseUrl}/geocode/json?address=${encodeURIComponent(cityName)}${countryCode ? `&country=${countryCode}` : ''}`;

    const data = await this.executeWithRetry<GoogleGeocodeResponse>(url, sanitizedLogUrl);

    if (data.status === 'ZERO_RESULTS') {
      logger.info({ cityName, countryCode }, 'Geocoding returned ZERO_RESULTS');
      return null;
    }

    if (data.status !== 'OK') {
      if (data.status === 'REQUEST_DENIED') {
        throw new Error(`Google Maps API error: REQUEST_DENIED (${data.error_message || 'Check API key or billing'})`);
      }
      if (data.status === 'OVER_QUERY_LIMIT') {
        throw new Error(`Google Maps API quota exceeded: OVER_QUERY_LIMIT`);
      }
      throw new Error(`Google Maps API error: ${data.status} - ${data.error_message || 'Unknown error'}`);
    }

    if (!data.results || data.results.length === 0) {
      return null;
    }

    return data.results[0];
  }

  /**
   * Resolves IANA timezone identifier for coordinates via Google Maps Time Zone API.
   */
  public async getTimezone(lat: number, lng: number): Promise<string | null> {
    if (!this.apiKey) {
      return null;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      location: `${lat},${lng}`,
      timestamp: timestamp.toString(),
      key: this.apiKey
    });

    const url = `${this.apiBaseUrl}/timezone/json?${params.toString()}`;
    const sanitizedLogUrl = `${this.apiBaseUrl}/timezone/json?location=${lat},${lng}`;

    try {
      const data = await this.executeWithRetry<GoogleTimezoneResponse>(url, sanitizedLogUrl);
      if (data.status === 'OK' && data.timeZoneId) {
        return data.timeZoneId;
      }
      logger.warn({ lat, lng, status: data.status }, 'Time Zone API did not return OK');
      return null;
    } catch (err: any) {
      logger.warn({ lat, lng, error: err.message }, 'Failed resolving timezone from Google API');
      return null;
    }
  }

  /**
   * Complete high-level retrieval: geocodes city, resolves timezone, normalizes, and validates.
   */
  public async fetchLocation(cityName: string, countryCode?: string): Promise<LocationRecord | null> {
    const geoResult = await this.geocodeCity(cityName, countryCode);
    if (!geoResult) {
      return null;
    }

    const lat = geoResult.geometry.location.lat;
    const lng = geoResult.geometry.location.lng;

    // Fetch IANA timezone
    const timezone = await this.getTimezone(lat, lng);

    // Map to canonical LocationRecord
    const record = this.mapGoogleResult(geoResult, cityName, countryCode, timezone);

    // Validate coordinates and schema
    const validation = this.validator.validateLocation(record);
    if (!validation.valid) {
      logger.warn({ id: record.id, errors: validation.errors }, 'API result failed location validation');
      throw new Error(`API returned invalid location record: ${validation.errors.join(', ')}`);
    }

    return record;
  }

  /**
   * Maps a Google Geocoding result to the canonical LocationRecord format.
   */
  public mapGoogleResult(
    geo: GoogleGeocodeResult,
    originalQuery: string,
    requestedCountry?: string,
    timezone?: string | null
  ): LocationRecord {
    let cityName = originalQuery;
    let countryCode = (requestedCountry || '').toUpperCase();
    let countryName = '';
    let admin1Code: string | null = null;
    let admin1Name: string | null = null;
    let admin2Code: string | null = null;

    for (const comp of geo.address_components) {
      if (comp.types.includes('locality') || comp.types.includes('postal_town')) {
        cityName = comp.long_name;
      }
      if (comp.types.includes('country')) {
        countryCode = comp.short_name.toUpperCase();
        countryName = comp.long_name;
      }
      if (comp.types.includes('administrative_area_level_1')) {
        admin1Code = comp.short_name;
        admin1Name = comp.long_name;
      }
      if (comp.types.includes('administrative_area_level_2')) {
        admin2Code = comp.short_name || comp.long_name;
      }
    }

    const isAdministrative = geo.types?.some((t) => t.startsWith('administrative_area')) ?? false;

    return {
      id: geo.place_id,
      name: cityName,
      asciiName: cityName.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      countryCode,
      countryName: countryName || countryCode,
      admin1Code,
      admin1Name,
      admin2Code,
      featureClass: null,
      featureCode: null,
      types: geo.types || [],
      latitude: geo.geometry.location.lat,
      longitude: geo.geometry.location.lng,
      timezone: timezone || null,
      population: null,
      elevation: null,
      modificationDate: null,
      source: 'google-maps',
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * HTTP request executor with exponential backoff and jitter.
   */
  private async executeWithRetry<T>(url: string, sanitizedLogUrl: string): Promise<T> {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      this.requestCount++;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        logger.debug({ url: sanitizedLogUrl, attempt }, 'Calling Google Maps API');
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'LocationPipeline/1.0 (GoogleMapsCacheClient)'
          }
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 429) {
            throw new Error(`HTTP 429 Too Many Requests`);
          }
          if (response.status >= 500) {
            throw new Error(`HTTP ${response.status} Server Error`);
          }
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as T;
        return data;
      } catch (err: any) {
        clearTimeout(timeoutId);

        const isLastAttempt = attempt > this.maxRetries;
        const isAbort = err.name === 'AbortError';

        logger.warn(
          {
            url: sanitizedLogUrl,
            attempt,
            maxRetries: this.maxRetries,
            error: err.message,
            isAbort
          },
          'Google Maps API call failed'
        );

        if (isLastAttempt) {
          throw new Error(`Google Maps API failed after ${attempt} attempts: ${err.message}`);
        }

        // Exponential backoff with jitter (e.g. 1s, 2s, 4s + 0-500ms jitter)
        const backoffMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new Error(`Exceeded max retries for ${sanitizedLogUrl}`);
  }
}

export const defaultApiClient = new GoogleMapsApiClient();
export default defaultApiClient;
