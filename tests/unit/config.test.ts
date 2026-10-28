import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/index.js';

describe('Pipeline Configuration', () => {
  it('loads valid defaults', () => {
    const cfg = parseConfig({});

    expect(cfg.batchSize).toBe(5000);
    expect(cfg.concurrency).toBe(2);
    expect(cfg.cronSchedule).toBe('0 3 * * 0');
    expect(cfg.cacheTtlDays).toBe(30);
    expect(cfg.countryCodes).toContain('IN');
    expect(cfg.countryCodes).toContain('US');
    expect(cfg.featureClasses).toEqual(['P', 'A']);
    expect(cfg.minPopulation).toBe(0);
    expect(cfg.baseUrl).toBe('https://download.geonames.org/export/dump/');
    expect(cfg.maxRetries).toBe(3);
  });

  it('correctly applies and normalizes custom environment variables', () => {
    const cfg = parseConfig({
      LOCATION_BATCH_SIZE: '10000',
      LOCATION_COUNTRY_CODES: ' in, us ,gb ',
      LOCATION_CRON_SCHEDULE: '0 0 * * *',
      LOCATION_MIN_POPULATION: '500',
      DOWNLOAD_MAX_RETRIES: '5'
    });

    expect(cfg.batchSize).toBe(10000);
    expect(cfg.countryCodes).toEqual(['IN', 'US', 'GB']);
    expect(cfg.cronSchedule).toBe('0 0 * * *');
    expect(cfg.minPopulation).toBe(500);
    expect(cfg.maxRetries).toBe(5);
  });

  it('rejects invalid non-positive batch size', () => {
    expect(() => {
      parseConfig({
        LOCATION_BATCH_SIZE: '-5'
      });
    }).toThrow();
  });

  it('rejects invalid base URL', () => {
    expect(() => {
      parseConfig({
        GEONAMES_BASE_URL: 'not-a-valid-url'
      });
    }).toThrow();
  });
});
