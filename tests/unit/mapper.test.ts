import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocationMapper } from '../../src/mapper/index.js';
import type { RawGeoNameRecord } from '../../src/types.js';

describe('Location Mapper', () => {
  const countryInfoFixture = path.resolve(__dirname, '../fixtures/sample-country-info.txt');
  const admin1Fixture = path.resolve(__dirname, '../fixtures/sample-admin1.txt');

  const rawSample: RawGeoNameRecord = {
    geonameid: '1269843',
    name: 'Hyderabad',
    asciiname: 'Hyderabad',
    alternatenames: ['Hyderabad', 'Haiderabad'],
    latitude: '17.38405',
    longitude: '78.45636',
    featureClass: 'P',
    featureCode: 'PPLA',
    countryCode: 'IN',
    cc2: [],
    admin1Code: '40',
    admin2Code: '',
    admin3Code: '',
    admin4Code: '',
    population: '6809970',
    elevation: '',
    dem: '515',
    timezone: 'Asia/Kolkata',
    modificationDate: '2024-01-15',
    lineNumber: 1
  };

  it('maps fields into canonical schema format', async () => {
    const mapper = new LocationMapper();
    await mapper.loadCountryInfo(countryInfoFixture);
    await mapper.loadAdmin1Codes(admin1Fixture);

    const mapped = mapper.mapRecord(rawSample, '2026-10-17T00:00:00.000Z');

    expect(mapped.id).toBe('1269843');
    expect(mapped.name).toBe('Hyderabad');
    expect(mapped.asciiName).toBe('Hyderabad');
    expect(mapped.countryCode).toBe('IN');
    expect(mapped.countryName).toBe('India');
    expect(mapped.admin1Code).toBe('40');
    expect(mapped.admin1Name).toBe('Telangana');
    expect(mapped.admin2Code).toBeNull();
    expect(mapped.featureClass).toBe('P');
    expect(mapped.featureCode).toBe('PPLA');
    expect(mapped.latitude).toBeCloseTo(17.38405);
    expect(mapped.longitude).toBeCloseTo(78.45636);
    expect(mapped.timezone).toBe('Asia/Kolkata');
    expect(mapped.population).toBe(6809970);
    expect(mapped.source).toBe('geonames');
    expect(mapped.updatedAt).toBe('2026-10-17T00:00:00.000Z');
  });

  it('treats population of 0 or missing as null', () => {
    const mapper = new LocationMapper();

    const zeroPop = mapper.mapRecord({ ...rawSample, population: '0' });
    expect(zeroPop.population).toBeNull();

    const emptyPop = mapper.mapRecord({ ...rawSample, population: '' });
    expect(emptyPop.population).toBeNull();
  });

  it('correctly maps UTF-8 special characters', () => {
    const mapper = new LocationMapper();
    const zurich: RawGeoNameRecord = {
      ...rawSample,
      geonameid: '2657896',
      name: 'Zürich',
      asciiname: 'Zurich',
      countryCode: 'CH'
    };

    const mapped = mapper.mapRecord(zurich);
    expect(mapped.name).toBe('Zürich');
    expect(mapped.asciiName).toBe('Zurich');
  });

  it('falls back to countryCode if country is unknown in metadata', () => {
    const mapper = new LocationMapper();
    const unknown: RawGeoNameRecord = {
      ...rawSample,
      countryCode: 'ZZ'
    };

    const mapped = mapper.mapRecord(unknown);
    expect(mapped.countryName).toBe('ZZ');
  });
});
