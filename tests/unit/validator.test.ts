import { beforeEach, describe, expect, it } from 'vitest';
import { LocationValidator } from '../../src/validator/index.js';
import type { LocationRecord } from '../../src/types.js';

describe('Location Validator', () => {
  let validator: LocationValidator;

  const validRecord: LocationRecord = {
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

  beforeEach(() => {
    validator = new LocationValidator();
  });

  it('approves a valid location record', () => {
    const res = validator.validateLocation(validRecord);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);

    const stats = validator.getStats();
    expect(stats.passed).toBe(1);
    expect(stats.failed).toBe(0);
  });

  it('rejects missing or empty id', () => {
    const res = validator.validateLocation({ ...validRecord, id: '' });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('Missing or empty ID');
  });

  it('rejects invalid country code', () => {
    const res1 = validator.validateLocation({ ...validRecord, countryCode: 'IND' });
    expect(res1.valid).toBe(false);

    const res2 = validator.validateLocation({ ...validRecord, countryCode: 'i' });
    expect(res2.valid).toBe(false);
  });

  it('rejects out of bounds latitude', () => {
    const resHigh = validator.validateLocation({ ...validRecord, latitude: 91.5 });
    expect(resHigh.valid).toBe(false);
    expect(resHigh.errors.some((e) => e.includes('Latitude out of range'))).toBe(true);

    const resLow = validator.validateLocation({ ...validRecord, latitude: -95.0 });
    expect(resLow.valid).toBe(false);
  });

  it('rejects out of bounds longitude', () => {
    const resHigh = validator.validateLocation({ ...validRecord, longitude: 185.0 });
    expect(resHigh.valid).toBe(false);
    expect(resHigh.errors.some((e) => e.includes('Longitude out of range'))).toBe(true);

    const resLow = validator.validateLocation({ ...validRecord, longitude: -190.0 });
    expect(resLow.valid).toBe(false);
  });

  it('rejects missing featureClass or featureCode', () => {
    const resClass = validator.validateLocation({ ...validRecord, featureClass: '' });
    expect(resClass.valid).toBe(false);

    const resCode = validator.validateLocation({ ...validRecord, featureCode: '' });
    expect(resCode.valid).toBe(false);
  });

  it('rejects negative population', () => {
    const res = validator.validateLocation({ ...validRecord, population: -100 });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('Population must be null or a non-negative number');
  });

  it('tracks failure statistics properly', () => {
    validator.validateLocation(validRecord); // pass
    validator.validateLocation({ ...validRecord, latitude: 120 }); // fail
    validator.validateLocation({ ...validRecord, countryCode: 'BAD' }); // fail

    const stats = validator.getStats();
    expect(stats.passed).toBe(1);
    expect(stats.failed).toBe(2);
  });
});
