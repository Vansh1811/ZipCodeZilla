import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { GeoNameDownloader, defaultDownloader } from '../downloader/index.js';
import { streamGeoNames } from '../parser/index.js';
import { LocationMapper, defaultMapper } from '../mapper/index.js';
import { LocationValidator, defaultValidator } from '../validator/index.js';
import { LocationExporter, StreamingJsonArrayWriter } from '../exporter/index.js';
import { StateManager } from '../state/index.js';
import type { CountryCoverage, LocationRecord, PipelineManifest, RunMode } from '../types.js';

const logger = createLogger({ module: 'pipeline' });

export interface PipelineRunOptions {
  mode: RunMode;
  targetCountry?: string;
  forceDownload?: boolean;
}

export class LocationPipeline {
  private downloader: GeoNameDownloader;
  private mapper: LocationMapper;
  private validator: LocationValidator;
  private exporter: LocationExporter;
  private stateManager: StateManager;
  private isInterrupted = false;

  constructor(options?: {
    downloader?: GeoNameDownloader;
    mapper?: LocationMapper;
    validator?: LocationValidator;
    exporter?: LocationExporter;
    stateManager?: StateManager;
  }) {
    this.downloader = options?.downloader || defaultDownloader;
    this.mapper = options?.mapper || defaultMapper;
    this.validator = options?.validator || defaultValidator;
    this.exporter = options?.exporter || new LocationExporter(config.dataDir);
    this.stateManager = options?.stateManager || new StateManager(config.dataDir);
  }

  /**
   * Main entry point to execute the ingestion pipeline.
   */
  public async run(options: PipelineRunOptions): Promise<boolean> {
    const existingState = this.stateManager.loadState();
    const runId = existingState && existingState.status === 'interrupted' && options.mode === existingState.mode
      ? existingState.runId
      : undefined;

    // Determine target countries
    let targetCountries: string[] = [];
    if (options.mode === 'country') {
      if (!options.targetCountry) {
        throw new Error('Country mode requires targetCountry option (e.g. --country IN)');
      }
      targetCountries = [options.targetCountry.toUpperCase()];
    } else {
      targetCountries = [...config.countryCodes];
    }

    const state = this.stateManager.initState(options.mode, targetCountries, existingState);

    // Acquire lock
    if (!this.stateManager.acquireLock(state.runId)) {
      logger.error('Could not acquire execution lock. Another instance is running.');
      return false;
    }

    // Register process signal handlers for graceful shutdown
    const cleanupHook = () => {
      if (!this.isInterrupted) {
        this.isInterrupted = true;
        logger.warn('Received termination signal. Gracefully shutting down pipeline...');
        this.stateManager.finishRun(state, 'interrupted', 'Process received shutdown signal');
        this.stateManager.releaseLock();
        process.exit(130);
      }
    };

    process.once('SIGINT', cleanupHook);
    process.once('SIGTERM', cleanupHook);

    try {
      logger.info({ mode: options.mode, countries: targetCountries, runId: state.runId }, 'Starting pipeline run');

      // 1. Download and load reference lookups
      await this.loadReferenceData();

      // 2. Mode handling
      if (options.mode === 'incremental') {
        await this.runIncrementalSync(state);
      } else if (options.mode === 'global') {
        await this.runGlobalIngestion(state);
      } else {
        // 3. Process countries in batches
        await this.processCountries(state, targetCountries);
      }

      // 4. Update manifest and countries index
      await this.generateOutputsAndManifest(state);

      this.stateManager.finishRun(state, 'completed');
      logger.info(
        {
          runId: state.runId,
          totalRecords: state.insertedRecords,
          completedCountries: state.countriesCompleted
        },
        'Pipeline completed successfully'
      );

      return true;
    } catch (err: any) {
      logger.error({ error: err.message, stack: err.stack }, 'Pipeline run failed');
      this.stateManager.finishRun(state, 'failed', err.message);
      return false;
    } finally {
      this.stateManager.releaseLock();
      process.removeListener('SIGINT', cleanupHook);
      process.removeListener('SIGTERM', cleanupHook);
    }
  }

  /**
   * Downloads and populates reference lookup maps.
   */
  private async loadReferenceData(): Promise<void> {
    try {
      logger.info('Ensuring reference datasets are available (countryInfo, admin1Codes)...');
      const { countryInfoPath, admin1CodesPath } = await this.downloader.downloadReferenceFiles();
      await this.mapper.loadCountryInfo(countryInfoPath);
      await this.mapper.loadAdmin1Codes(admin1CodesPath);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed downloading online reference files, continuing with fallback maps');
    }
  }

  /**
   * Processes a list of countries with streaming ingestion and bounded memory.
   */
  public async processCountries(state: any, countries: string[]): Promise<void> {
    for (const countryCode of countries) {
      if (this.isInterrupted) break;

      state.currentCountry = countryCode;
      this.stateManager.saveState(state);

      logger.info({ countryCode }, `Processing country dataset: ${countryCode}`);

      let txtPath: string;
      try {
        txtPath = await this.downloader.downloadAndExtractCountry(countryCode);
      } catch (err: any) {
        logger.error({ countryCode, error: err.message }, `Failed downloading dataset for ${countryCode}`);
        state.failedRecords++;
        this.stateManager.saveState(state);
        continue;
      }

      await this.processCountryFile(state, countryCode, txtPath);
    }
  }

  /**
   * Processes a single country TSV file, filtering, mapping, and streaming to JSON.
   */
  public async processCountryFile(
    state: any,
    countryCode: string,
    tsvPath: string
  ): Promise<number> {
    const isIndia = countryCode.toUpperCase() === 'IN';
    const countryWriter = this.exporter.createCountryWriter(countryCode);
    const citiesWriter = isIndia
      ? this.exporter.createIndiaCitiesWriter()
      : this.exporter.createCountryCitiesWriter(countryCode);
    const statesWriter = isIndia
      ? this.exporter.createIndiaStatesWriter()
      : this.exporter.createCountryStatesWriter(countryCode);

    const seenIds = new Set<string>();
    let processedInCountry = 0;
    let validInCountry = 0;
    const nowIso = new Date().toISOString();

    try {
      for await (const raw of streamGeoNames(tsvPath)) {
        if (this.isInterrupted) {
          countryWriter.abort();
          citiesWriter?.abort();
          statesWriter?.abort();
          throw new Error('Pipeline was interrupted during country processing');
        }

        processedInCountry++;
        state.processedRecords++;

        // Ensure record matches target country
        if (raw.countryCode.toUpperCase() !== countryCode.toUpperCase()) {
          state.skippedRecords++;
          continue;
        }

        // Filter by feature class if configured (e.g. 'P' for populated place, 'A' for admin)
        if (config.featureClasses.length > 0 && !config.featureClasses.includes(raw.featureClass)) {
          state.skippedRecords++;
          continue;
        }

        // Deduplicate within the country by geonameid
        if (seenIds.has(raw.geonameid)) {
          state.skippedRecords++;
          continue;
        }
        seenIds.add(raw.geonameid);

        // Filter by minimum population if set
        if (config.minPopulation > 0) {
          const pop = raw.population ? parseInt(raw.population, 10) : 0;
          if (pop < config.minPopulation) {
            state.skippedRecords++;
            continue;
          }
        }

        // Map to canonical record
        const record = this.mapper.mapRecord(raw, nowIso);

        // Validate
        const validation = this.validator.validateLocation(record);
        if (!validation.valid) {
          state.failedRecords++;
          continue;
        }

        // Write to country export stream
        countryWriter.write(record);
        validInCountry++;

        // Partitioned exports by feature class
        if (raw.featureClass === 'P' && citiesWriter) {
          citiesWriter.write(record);
        } else if (raw.featureClass === 'A' && statesWriter) {
          statesWriter.write(record);
        }

        // Periodic checkpointing
        if (processedInCountry % config.batchSize === 0) {
          this.stateManager.updateCountryCheckpoint(
            state,
            countryCode,
            raw.lineNumber,
            validInCountry
          );
          logger.info(
            {
              countryCode,
              processed: processedInCountry,
              valid: validInCountry
            },
            'Processing batch progress'
          );
        }
      }

      // Close all active streams cleanly
      await countryWriter.close();
      if (citiesWriter) await citiesWriter.close();
      if (statesWriter) await statesWriter.close();

      // Automatically build/update high-performance index for this country
      try {
        const { LocalGeoNamesResolver } = await import('../cache/localResolver.js');
        const resolver = new LocalGeoNamesResolver({ dataDir: this.exporter.getDataDir() });
        await resolver.buildIndex(countryCode);
      } catch (err: any) {
        logger.warn({ countryCode, error: err.message }, 'Could not build index during country processing');
      }

      this.stateManager.markCountryCompleted(state, countryCode, validInCountry);
      logger.info(
        { countryCode, totalProcessed: processedInCountry, totalExported: validInCountry },
        `Finished country: ${countryCode}`
      );

      return validInCountry;
    } catch (err: any) {
      countryWriter.abort();
      citiesWriter?.abort();
      statesWriter?.abort();
      throw err;
    }
  }

  /**
   * Ingests worldwide populated places and capitals from the cities500 dataset.
   * Partitions by country, builds country-specific prefix offset indexes, and updates manifests.
   * Comprehensive India dataset is preserved untouched.
   */
  public async runGlobalIngestion(state: any, customDatasetPath?: string): Promise<number> {
    let tsvPath = customDatasetPath;
    if (!tsvPath || !fs.existsSync(tsvPath)) {
      const defaultTxt = path.join(config.downloadsDir, 'cities500.txt');
      if (fs.existsSync(defaultTxt)) {
        tsvPath = defaultTxt;
      } else {
        logger.info('cities500.txt not found locally, downloading and extracting...');
        tsvPath = await this.downloader.downloadAndExtractGlobalCities('cities500.zip');
      }
    }

    logger.info({ tsvPath }, 'Starting global cities ingestion from cities500 dataset');
    const recordsByCountry = new Map<string, LocationRecord[]>();
    const nowIso = new Date().toISOString();
    let totalProcessed = 0;
    let totalValid = 0;

    for await (const raw of streamGeoNames(tsvPath)) {
      if (this.isInterrupted) {
        throw new Error('Pipeline was interrupted during global ingestion');
      }
      totalProcessed++;
      state.processedRecords++;

      const countryCode = raw.countryCode.toUpperCase();
      // Skip India if India already has comprehensive local dataset
      if (countryCode === 'IN' && fs.existsSync(this.exporter.getIndiaCitiesFilePath())) {
        state.skippedRecords++;
        continue;
      }

      // Feature class filtering: populated places ('P') and administrative capitals ('A')
      if (config.featureClasses.length > 0 && !config.featureClasses.includes(raw.featureClass)) {
        state.skippedRecords++;
        continue;
      }

      const record = this.mapper.mapRecord(raw, nowIso);
      const validation = this.validator.validateLocation(record);
      if (!validation.valid) {
        state.failedRecords++;
        continue;
      }

      let list = recordsByCountry.get(countryCode);
      if (!list) {
        list = [];
        recordsByCountry.set(countryCode, list);
      }
      list.push(record);
      totalValid++;
    }

    logger.info(
      { totalProcessed, totalValid, totalCountries: recordsByCountry.size },
      'Parsed and grouped global cities by country'
    );

    // Target countries to partition: priority countries from config plus any country with records
    const targetCodes = new Set([
      ...config.countryCodes.map((c) => c.toUpperCase()),
      ...Array.from(recordsByCountry.keys())
    ]);

    const { LocalGeoNamesResolver } = await import('../cache/localResolver.js');
    const resolver = new LocalGeoNamesResolver({ dataDir: this.exporter.getDataDir() });

    for (const countryCode of targetCodes) {
      if (countryCode === 'IN') continue; // India preserved

      const records = recordsByCountry.get(countryCode);
      if (!records || records.length === 0) continue;

      logger.info({ countryCode, recordCount: records.length }, 'Exporting country partition and building index');

      // Sort deterministically
      records.sort((a, b) => a.name.localeCompare(b.name));

      // Separate populated places and administrative divisions
      const cities = records.filter(
        (r) => !(r.featureClass === 'A' || (r.types && r.types.includes('administrative_area_level_1')))
      );
      const states = records.filter(
        (r) => r.featureClass === 'A' || (r.types && r.types.includes('administrative_area_level_1'))
      );

      // Write partitioned cities.json
      if (cities.length > 0) {
        const writer = this.exporter.createCountryCitiesWriter(countryCode);
        for (const rec of cities) {
          writer.write(rec);
        }
        await writer.close();
      }

      // Write partitioned states.json if any
      if (states.length > 0) {
        const writer = this.exporter.createCountryStatesWriter(countryCode);
        for (const rec of states) {
          writer.write(rec);
        }
        await writer.close();
      }

      // Build prefix index for fast sub-millisecond lookups
      await resolver.buildIndex(countryCode);

      state.insertedRecords += records.length;
      if (!state.countriesCompleted.includes(countryCode)) {
        state.countriesCompleted.push(countryCode);
      }
    }

    // Refresh manifest and country index with updated coverage and checksums
    await this.exporter.refreshIndexAndManifest();

    return totalValid;
  }

  /**
   * Handles daily incremental synchronization using GeoNames modifications file.
   */
  private async runIncrementalSync(state: any): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);
    const modFileName = `modifications-${dateStr}.txt`;

    logger.info({ modFileName }, 'Fetching daily modifications dataset');
    try {
      const modFilePath = await this.downloader.downloadFile(modFileName);
      let count = 0;
      const modifiedCountries = new Set<string>();

      for await (const raw of streamGeoNames(modFilePath)) {
        count++;
        if (config.countryCodes.includes(raw.countryCode)) {
          modifiedCountries.add(raw.countryCode);
        }
      }

      logger.info(
        { count, affectedCountries: Array.from(modifiedCountries) },
        'Parsed daily modifications file'
      );

      // Re-export affected countries to ensure deterministic state
      if (modifiedCountries.size > 0) {
        logger.info(
          { countries: Array.from(modifiedCountries) },
          'Refreshing countries affected by incremental updates'
        );
        await this.processCountries(state, Array.from(modifiedCountries));
      }
    } catch (err: any) {
      logger.warn(
        { error: err.message },
        'Daily modifications file was unavailable or not found, falling back to full check'
      );
    }
  }

  /**
   * Generates countries.json index and manifest.json with file checksums.
   */
  public async generateOutputsAndManifest(state: any): Promise<PipelineManifest> {
    const coverageList: CountryCoverage[] = [];
    const checksums: Record<string, string> = {};
    let totalRecords = 0;

    const countriesDir = this.exporter.getCountriesDir();
    if (fs.existsSync(countriesDir)) {
      const files = fs.readdirSync(countriesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.cache.json'));

      for (const file of files) {
        const countryCode = path.basename(file, '.json').toUpperCase();
        const filePath = path.join(countriesDir, file);
        const checksum = await LocationExporter.calculateFileChecksum(filePath);
        checksums[`countries/${file}`] = checksum;

        let count = 0;
        let countryName = countryCode;

        let isLarge = false;
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 5 * 1024 * 1024) {
            isLarge = true;
          }
        } catch {}

        if (isLarge) {
          const checkpointCount = state?.checkpoints?.[countryCode]?.recordCount;
          if (checkpointCount !== undefined && checkpointCount > 0) {
            count = checkpointCount;
            countryName = countryCode === 'IN' ? 'India' : countryCode;
          } else {
            const streamed = await LocationExporter.countRecordsInJsonFile(filePath);
            count = streamed.count;
            countryName = streamed.countryName || countryCode;
          }

          totalRecords += count;
          coverageList.push({
            code: countryCode,
            name: countryName,
            recordCount: count
          });
        } else {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const records: LocationRecord[] = JSON.parse(content);
            count = records.length;
            totalRecords += count;

            coverageList.push({
              code: countryCode,
              name: records[0]?.countryName || countryCode,
              recordCount: count
            });
          } catch {
            const fallbackCount = state?.checkpoints?.[countryCode]?.recordCount || 0;
            totalRecords += fallbackCount;
            coverageList.push({
              code: countryCode,
              name: countryCode,
              recordCount: fallbackCount
            });
          }
        }
      }
    }

    // Checksums for India partitioned files if present
    const indiaCitiesPath = this.exporter.getIndiaCitiesFilePath();
    if (fs.existsSync(indiaCitiesPath)) {
      checksums['india/cities.json'] = await LocationExporter.calculateFileChecksum(indiaCitiesPath);
    }

    const indiaStatesPath = this.exporter.getIndiaStatesFilePath();
    if (fs.existsSync(indiaStatesPath)) {
      checksums['india/states.json'] = await LocationExporter.calculateFileChecksum(indiaStatesPath);
    }

    // Write countries.json
    await this.exporter.writeCountriesIndex(coverageList);
    const countriesIndexPath = this.exporter.getCountriesIndexFilePath();
    if (fs.existsSync(countriesIndexPath)) {
      checksums['countries.json'] = await LocationExporter.calculateFileChecksum(countriesIndexPath);
    }

    const manifest: PipelineManifest = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: 'geonames',
      license: 'Creative Commons Attribution 4.0 (CC-BY 4.0)',
      attribution: 'GeoNames (www.geonames.org)',
      totalRecords,
      countryCoverage: coverageList,
      status: 'completed',
      checksums
    };

    await this.exporter.writeManifest(manifest);
    return manifest;
  }
}

export const defaultPipeline = new LocationPipeline();
export default defaultPipeline;
