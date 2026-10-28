import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocationPipeline } from '../../src/pipeline/index.js';
import { LocationMapper } from '../../src/mapper/index.js';
import { LocationValidator } from '../../src/validator/index.js';
import { LocationExporter } from '../../src/exporter/index.js';
import { StateManager } from '../../src/state/index.js';
import type { GeoNameDownloader } from '../../src/downloader/index.js';

describe('Location Ingestion Pipeline Integration Test', () => {
  let tempDir: string;
  let pipeline: LocationPipeline;
  let stateManager: StateManager;
  let exporter: LocationExporter;

  const fixturesDir = path.resolve(__dirname, '../fixtures');
  const geonamesFixture = path.join(fixturesDir, 'sample-geonames.txt');
  const countryInfoFixture = path.join(fixturesDir, 'sample-country-info.txt');
  const admin1Fixture = path.join(fixturesDir, 'sample-admin1.txt');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'location-integration-'));
    stateManager = new StateManager(tempDir);
    exporter = new LocationExporter(tempDir);

    const mapper = new LocationMapper();
    const validator = new LocationValidator();

    // Mock downloader that provides local fixture files instead of downloading from network
    const mockDownloader = {
      downloadFile: async (filename: string) => {
        if (filename.includes('countryInfo')) return countryInfoFixture;
        if (filename.includes('admin1Codes')) return admin1Fixture;
        return geonamesFixture;
      },
      extractZip: async () => geonamesFixture,
      downloadAndExtractCountry: async () => geonamesFixture,
      downloadReferenceFiles: async () => ({
        countryInfoPath: countryInfoFixture,
        admin1CodesPath: admin1Fixture
      })
    } as unknown as GeoNameDownloader;

    pipeline = new LocationPipeline({
      downloader: mockDownloader,
      mapper,
      validator,
      exporter,
      stateManager
    });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('executes complete ingestion and produces validated JSON outputs and manifest', async () => {
    const success = await pipeline.run({
      mode: 'country',
      targetCountry: 'IN'
    });

    expect(success).toBe(true);

    // Verify country file IN.json
    const inJsonPath = exporter.getCountryFilePath('IN');
    expect(fs.existsSync(inJsonPath)).toBe(true);

    const inRecords = JSON.parse(fs.readFileSync(inJsonPath, 'utf8'));
    expect(Array.isArray(inRecords)).toBe(true);

    // In sample-geonames.txt:
    // - Hyderabad (P, PPLA, IN) -> Valid
    // - Delhi State (A, ADM1, IN) -> Valid
    // - Small Village (P, PPL, IN) -> Valid
    // - Zürich, NYC, London -> Ignored (different countries)
    // - Hyderabad Duplicate -> Deduplicated out
    // - Invalid Lat -> Rejected
    // - Invalid Country Code -> Rejected
    // - Malformed line -> Skipped
    expect(inRecords.length).toBe(3);

    const hyderabad = inRecords.find((r: any) => r.id === '1269843');
    expect(hyderabad).toBeDefined();
    expect(hyderabad.countryName).toBe('India');
    expect(hyderabad.admin1Name).toBe('Telangana');
    expect(hyderabad.timezone).toBe('Asia/Kolkata');
    expect(hyderabad.population).toBe(6809970);

    // Verify India partitioned files
    const indiaCitiesPath = exporter.getIndiaCitiesFilePath();
    expect(fs.existsSync(indiaCitiesPath)).toBe(true);
    const indiaCities = JSON.parse(fs.readFileSync(indiaCitiesPath, 'utf8'));
    // Only 'P' featureClass records (Hyderabad, Small Village)
    expect(indiaCities.length).toBe(2);

    const indiaStatesPath = exporter.getIndiaStatesFilePath();
    expect(fs.existsSync(indiaStatesPath)).toBe(true);
    const indiaStates = JSON.parse(fs.readFileSync(indiaStatesPath, 'utf8'));
    // Only 'A' featureClass records (Delhi)
    expect(indiaStates.length).toBe(1);
    expect(indiaStates[0].name).toContain('Delhi');

    // Verify countries.json index
    const countriesIndexPath = exporter.getCountriesIndexFilePath();
    expect(fs.existsSync(countriesIndexPath)).toBe(true);
    const countriesIndex = JSON.parse(fs.readFileSync(countriesIndexPath, 'utf8'));
    expect(countriesIndex.length).toBe(1);
    expect(countriesIndex[0].code).toBe('IN');
    expect(countriesIndex[0].recordCount).toBe(3);

    // Verify manifest.json
    const manifestPath = exporter.getManifestFilePath();
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(manifest.totalRecords).toBe(3);
    expect(manifest.source).toBe('geonames');
    expect(manifest.checksums['countries/IN.json']).toBeDefined();
    expect(manifest.checksums['india/cities.json']).toBeDefined();
    expect(manifest.checksums['india/states.json']).toBeDefined();

    // Verify run state persistence
    const state = stateManager.loadState();
    expect(state).not.toBeNull();
    expect(state?.status).toBe('completed');
    expect(state?.countriesCompleted).toContain('IN');
    expect(state?.insertedRecords).toBe(3);
  });

  it('prevents overlapping runs using concurrency lock', async () => {
    // Acquire lock manually
    const locked = stateManager.acquireLock('test-run-1');
    expect(locked).toBe(true);

    // Attempting pipeline run while lock is active should return false
    const success = await pipeline.run({
      mode: 'country',
      targetCountry: 'IN'
    });

    expect(success).toBe(false);

    stateManager.releaseLock();
  });
});
