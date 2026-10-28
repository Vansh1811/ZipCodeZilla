import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocationExporter, StreamingJsonArrayWriter } from '../../src/exporter/index.js';
import type { LocationRecord, PipelineManifest } from '../../src/types.js';

describe('Location Exporter', () => {
  let tempDir: string;
  let exporter: LocationExporter;

  const sampleRecord: LocationRecord = {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'location-test-export-'));
    exporter = new LocationExporter(tempDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('streams records and writes valid JSON array with checksum', async () => {
    const writer = exporter.createCountryWriter('IN');
    writer.write(sampleRecord);
    writer.write({ ...sampleRecord, id: '1269844', name: 'Secunderabad' });

    const result = await writer.close();

    expect(result.recordCount).toBe(2);
    expect(fs.existsSync(result.finalPath)).toBe(true);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);

    // Read back and verify valid JSON
    const content = fs.readFileSync(result.finalPath, 'utf8');
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].name).toBe('Hyderabad');
    expect(parsed[1].name).toBe('Secunderabad');
  });

  it('handles empty writer cleanly (writes valid empty array)', async () => {
    const writer = exporter.createCountryWriter('XX');
    const result = await writer.close();

    expect(result.recordCount).toBe(0);
    const content = fs.readFileSync(result.finalPath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual([]);
  });

  it('writes and validates manifest.json', async () => {
    const manifest: PipelineManifest = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: 'geonames',
      totalRecords: 100,
      countryCoverage: [{ code: 'IN', name: 'India', recordCount: 100 }],
      status: 'completed',
      checksums: { 'countries/IN.json': 'abcdef1234567890' }
    };

    const manifestPath = await exporter.writeManifest(manifest);
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(content.source).toBe('geonames');
    expect(content.totalRecords).toBe(100);
  });

  it('writes and sorts countries.json index alphabetically', async () => {
    const coverage = [
      { code: 'US', name: 'United States', recordCount: 200 },
      { code: 'AU', name: 'Australia', recordCount: 50 },
      { code: 'IN', name: 'India', recordCount: 300 }
    ];

    const indexPath = await exporter.writeCountriesIndex(coverage);
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    expect(parsed[0].name).toBe('Australia');
    expect(parsed[1].name).toBe('India');
    expect(parsed[2].name).toBe('United States');
  });

  it('rejects invalid JSON files during validation', async () => {
    const badFilePath = path.join(tempDir, 'bad.json');
    fs.writeFileSync(badFilePath, '{ this is not valid json', 'utf8');

    await expect(LocationExporter.validateJsonFile(badFilePath)).rejects.toThrow();
  });
});
