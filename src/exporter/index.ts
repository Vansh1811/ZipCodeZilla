import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CountryCoverage, LocationRecord, PipelineManifest } from '../types.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger({ module: 'exporter' });

/**
 * Stream writer that outputs an array of JSON objects without holding all records in memory.
 * Computes SHA-256 checksum on the fly.
 */
export class StreamingJsonArrayWriter<T> {
  private stream: fs.WriteStream;
  private hash: crypto.Hash;
  private tempPath: string;
  private finalPath: string;
  private isFirst = true;
  private recordCount = 0;
  private isClosed = false;

  constructor(finalPath: string) {
    this.finalPath = finalPath;
    const dir = path.dirname(finalPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.tempPath = `${finalPath}.tmp`;
    this.stream = fs.createWriteStream(this.tempPath, { encoding: 'utf8' });
    this.hash = crypto.createHash('sha256');

    // Write opening bracket
    const header = '[\n';
    this.stream.write(header);
    this.hash.update(header);
  }

  public write(record: T): void {
    if (this.isClosed) {
      throw new Error(`Cannot write to closed writer: ${this.finalPath}`);
    }

    const separator = this.isFirst ? '  ' : ',\n  ';
    this.isFirst = false;

    const chunk = `${separator}${JSON.stringify(record)}`;
    this.stream.write(chunk);
    this.hash.update(chunk);
    this.recordCount++;
  }

  public async close(): Promise<{ finalPath: string; recordCount: number; checksum: string }> {
    if (this.isClosed) {
      throw new Error(`Writer already closed: ${this.finalPath}`);
    }
    this.isClosed = true;

    const footer = '\n]\n';
    this.stream.write(footer);
    this.hash.update(footer);

    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Validate that the generated temp file is valid JSON before atomic rename
    await LocationExporter.validateJsonFile(this.tempPath);

    // Atomically move temp file to destination
    fs.renameSync(this.tempPath, this.finalPath);

    const checksum = this.hash.digest('hex');
    logger.debug(
      { file: this.finalPath, recordCount: this.recordCount, checksum },
      'Successfully generated JSON export'
    );

    return {
      finalPath: this.finalPath,
      recordCount: this.recordCount,
      checksum
    };
  }

  public abort(): void {
    if (!this.isClosed) {
      this.isClosed = true;
      this.stream.destroy();
      if (fs.existsSync(this.tempPath)) {
        try {
          fs.unlinkSync(this.tempPath);
        } catch {
          // Ignore unlink error on abort
        }
      }
    }
  }
}

export class LocationExporter {
  private dataDir: string;
  private writeLocks = new Map<string, Promise<void>>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  public getDataDir(): string {
    return this.dataDir;
  }

  public getCountriesDir(): string {
    return path.join(this.dataDir, 'countries');
  }

  public getIndiaDir(): string {
    return path.join(this.dataDir, 'india');
  }

  public getCountryDir(countryCode: string): string {
    const code = countryCode.toUpperCase();
    if (code === 'IN') {
      return this.getIndiaDir();
    }
    return path.join(this.dataDir, countryCode.toLowerCase());
  }

  public getCountryFilePath(countryCode: string): string {
    return path.join(this.getCountriesDir(), `${countryCode.toUpperCase()}.json`);
  }

  public getIndiaCitiesFilePath(): string {
    return path.join(this.getIndiaDir(), 'cities.json');
  }

  public getIndiaStatesFilePath(): string {
    return path.join(this.getIndiaDir(), 'states.json');
  }

  public getCountryCitiesFilePath(countryCode: string): string {
    return path.join(this.getCountryDir(countryCode), 'cities.json');
  }

  public getCountryStatesFilePath(countryCode: string): string {
    return path.join(this.getCountryDir(countryCode), 'states.json');
  }

  public getCountriesIndexFilePath(): string {
    return path.join(this.dataDir, 'countries.json');
  }

  public getManifestFilePath(): string {
    return path.join(this.dataDir, 'manifest.json');
  }

  public getCacheManifestFilePath(): string {
    return path.join(this.dataDir, 'manifest.cache.json');
  }

  public getCountryCacheFilePath(countryCode: string): string {
    const code = countryCode.toUpperCase();
    const cachePath = path.join(this.getCountriesDir(), `${code}.cache.json`);
    if (this.hasBulkExport(code) || fs.existsSync(cachePath)) {
      return cachePath;
    }
    return this.getCountryFilePath(code);
  }

  public hasBulkExport(countryCode: string): boolean {
    const code = countryCode.toUpperCase();
    if (code === 'IN') {
      const citiesPath = this.getIndiaCitiesFilePath();
      if (fs.existsSync(citiesPath)) {
        try {
          if (fs.statSync(citiesPath).size > 5 * 1024 * 1024) {
            return true;
          }
        } catch {
          // ignore stat error
        }
      }
    } else {
      const countryDir = this.getCountryDir(code);
      const citiesPath = path.join(countryDir, 'cities.json');
      if (fs.existsSync(citiesPath)) {
        return true;
      }
    }
    const countryFilePath = this.getCountryFilePath(code);
    if (fs.existsSync(countryFilePath)) {
      try {
        const stat = fs.statSync(countryFilePath);
        if (stat.size > 5 * 1024 * 1024) {
          return true;
        }
      } catch {
        // ignore stat error
      }
    }
    return false;
  }

  public createCountryWriter(countryCode: string): StreamingJsonArrayWriter<LocationRecord> {
    const finalPath = this.getCountryFilePath(countryCode);
    return new StreamingJsonArrayWriter<LocationRecord>(finalPath);
  }

  public createIndiaCitiesWriter(): StreamingJsonArrayWriter<LocationRecord> {
    return new StreamingJsonArrayWriter<LocationRecord>(this.getIndiaCitiesFilePath());
  }

  public createIndiaStatesWriter(): StreamingJsonArrayWriter<LocationRecord> {
    return new StreamingJsonArrayWriter<LocationRecord>(this.getIndiaStatesFilePath());
  }

  public createCountryCitiesWriter(countryCode: string): StreamingJsonArrayWriter<LocationRecord> {
    return new StreamingJsonArrayWriter<LocationRecord>(this.getCountryCitiesFilePath(countryCode));
  }

  public createCountryStatesWriter(countryCode: string): StreamingJsonArrayWriter<LocationRecord> {
    return new StreamingJsonArrayWriter<LocationRecord>(this.getCountryStatesFilePath(countryCode));
  }

  /**
   * Reads all cached records for a given country ISO code.
   */
  public loadCountryRecords(countryCode: string): LocationRecord[] {
    const filePath = this.getCountryFilePath(countryCode);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content) as LocationRecord[];
    } catch (err: any) {
      logger.error({ countryCode, error: err.message }, 'Failed reading country JSON file');
      return [];
    }
  }

  /**
   * Reads all cached Google Maps records for a given country ISO code.
   * Does NOT touch bulk open-data files.
   */
  public loadCountryCacheRecords(countryCode: string): LocationRecord[] {
    const filePath = this.getCountryCacheFilePath(countryCode);
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content) as LocationRecord[];
    } catch (err: any) {
      logger.error({ countryCode, error: err.message }, 'Failed reading country cache JSON file');
      return [];
    }
  }

  /**
   * Thread-safe / serialized upsert of a single location record into the country file and partitions.
   * If country has bulk open data, writes to country cache partition without loading bulk files.
   */
  public async upsertCountryRecord(record: LocationRecord): Promise<void> {
    const countryCode = record.countryCode.toUpperCase();
    const lockKey = countryCode;

    // Serialize writes per country to avoid race conditions
    const prevLock = this.writeLocks.get(lockKey) || Promise.resolve();
    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.writeLocks.set(lockKey, newLock);

    await prevLock;
    try {
      const isBulk = this.hasBulkExport(countryCode);
      const targetFilePath = isBulk
        ? this.getCountryCacheFilePath(countryCode)
        : this.getCountryFilePath(countryCode);

      const records = isBulk
        ? this.loadCountryCacheRecords(countryCode)
        : this.loadCountryRecords(countryCode);

      const existingIdx = records.findIndex(
        (r) => r.id === record.id || (r.name.toLowerCase() === record.name.toLowerCase() && r.admin1Code === record.admin1Code)
      );

      if (existingIdx >= 0) {
        records[existingIdx] = record;
      } else {
        records.push(record);
      }

      // Sort deterministically by name
      records.sort((a, b) => a.name.localeCompare(b.name));

      // Atomically write updated country records
      await this.writeArrayAtomically(targetFilePath, records);

      // Handle India partitions if applicable (ONLY for non-bulk datasets)
      if (countryCode === 'IN' && !isBulk) {
        const isState =
          record.featureClass === 'A' ||
          (record.types && record.types.includes('administrative_area_level_1'));
        if (isState) {
          await this.upsertPartitionRecord(this.getIndiaStatesFilePath(), record);
        } else {
          await this.upsertPartitionRecord(this.getIndiaCitiesFilePath(), record);
        }
      }

      // Refresh cache manifest (preserves bulk manifest.json untouched)
      await this.refreshCacheManifest();
    } finally {
      releaseLock!();
    }
  }

  /**
   * Thread-safe overwrite of all records for a given country ISO code.
   * Also synchronizes India partition files if applicable.
   */
  public async saveCountryRecords(countryCode: string, records: LocationRecord[]): Promise<void> {
    const code = countryCode.toUpperCase();
    const lockKey = code;

    const prevLock = this.writeLocks.get(lockKey) || Promise.resolve();
    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.writeLocks.set(lockKey, newLock);

    await prevLock;
    try {
      const targetFilePath = this.getCountryCacheFilePath(code);
      const isBulk = this.hasBulkExport(code);
      const sortedRecords = [...records].sort((a, b) => a.name.localeCompare(b.name));
      await this.writeArrayAtomically(targetFilePath, sortedRecords);

      if (code === 'IN' && !isBulk) {
        const cities = sortedRecords.filter(
          (r) => !(r.featureClass === 'A' || (r.types && r.types.includes('administrative_area_level_1')))
        );
        const states = sortedRecords.filter(
          (r) => r.featureClass === 'A' || (r.types && r.types.includes('administrative_area_level_1'))
        );
        await this.writeArrayAtomically(this.getIndiaCitiesFilePath(), cities);
        await this.writeArrayAtomically(this.getIndiaStatesFilePath(), states);
      }
    } finally {
      releaseLock!();
    }
  }

  private async upsertPartitionRecord(filePath: string, record: LocationRecord): Promise<void> {
    let records: LocationRecord[] = [];
    if (fs.existsSync(filePath)) {
      try {
        records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        records = [];
      }
    }

    const idx = records.findIndex((r) => r.id === record.id || r.name.toLowerCase() === record.name.toLowerCase());
    if (idx >= 0) {
      records[idx] = record;
    } else {
      records.push(record);
    }
    records.sort((a, b) => a.name.localeCompare(b.name));
    await this.writeArrayAtomically(filePath, records);
  }

  private async writeArrayAtomically(filePath: string, records: LocationRecord[]): Promise<void> {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${filePath}.tmp`;
    const jsonStr = JSON.stringify(records, null, 2);
    fs.writeFileSync(tempPath, jsonStr, 'utf8');
    await LocationExporter.validateJsonFile(tempPath);
    fs.renameSync(tempPath, filePath);
  }

  /**
   * Generates manifest.cache.json with checksums and statistics for cached Google Maps records.
   */
  public async writeCacheManifest(manifest: PipelineManifest): Promise<string> {
    const filePath = this.getCacheManifestFilePath();
    const tempPath = `${filePath}.tmp`;

    const content = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(tempPath, content, 'utf8');
    await LocationExporter.validateJsonFile(tempPath);
    fs.renameSync(tempPath, filePath);

    logger.debug({ totalRecords: manifest.totalRecords, status: manifest.status }, 'Wrote cache manifest');
    return filePath;
  }

  /**
   * Refreshes cache manifest based strictly on Google Maps cache files (.cache.json and small non-bulk files).
   * Does NOT touch or overwrite the bulk GeoNames manifest.json.
   */
  public async refreshCacheManifest(): Promise<PipelineManifest> {
    const coverageList: CountryCoverage[] = [];
    const checksums: Record<string, string> = {};
    let totalRecords = 0;

    const countriesDir = this.getCountriesDir();
    if (fs.existsSync(countriesDir)) {
      const files = fs.readdirSync(countriesDir).filter((f) => f.endsWith('.json'));

      for (const file of files) {
        const filePath = path.join(countriesDir, file);
        let countryCode: string;
        let isCacheFile = false;

        if (file.endsWith('.cache.json')) {
          countryCode = file.replace(/\.cache\.json$/i, '').toUpperCase();
          isCacheFile = true;
        } else {
          countryCode = path.basename(file, '.json').toUpperCase();
          // Regular .json files are considered cache files only if they are not bulk datasets
          if (!this.hasBulkExport(countryCode)) {
            isCacheFile = true;
          }
        }

        if (isCacheFile) {
          const checksum = await LocationExporter.calculateFileChecksum(filePath);
          checksums[`countries/${file}`] = checksum;

          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const records: LocationRecord[] = JSON.parse(content);
            const count = records.length;
            totalRecords += count;

            coverageList.push({
              code: countryCode,
              name: records[0]?.countryName || countryCode,
              recordCount: count
            });
          } catch {
            coverageList.push({
              code: countryCode,
              name: countryCode,
              recordCount: 0
            });
          }
        }
      }
    }

    coverageList.sort((a, b) => a.code.localeCompare(b.code));

    const manifest: PipelineManifest = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: 'google-maps',
      license: 'Proprietary - Subject to Google Maps Platform Terms of Service (30-day coordinate retention)',
      attribution: 'Google Maps Platform (maps.googleapis.com)',
      totalRecords,
      countryCoverage: coverageList,
      status: 'completed',
      checksums
    };

    await this.writeCacheManifest(manifest);
    return manifest;
  }

  /**
   * Refreshes countries index and manifest based on bulk dataset files.
   * Preserves existing open-data attribution and ignores cache partitions.
   */
  public async refreshIndexAndManifest(): Promise<PipelineManifest> {
    const coverageList: CountryCoverage[] = [];
    const checksums: Record<string, string> = {};
    let totalRecords = 0;

    const countriesDir = this.getCountriesDir();
    if (fs.existsSync(countriesDir)) {
      const files = fs.readdirSync(countriesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.cache.json'));

      for (const file of files) {
        const countryCode = path.basename(file, '.json').toUpperCase();
        const filePath = path.join(countriesDir, file);
        const checksum = await LocationExporter.calculateFileChecksum(filePath);
        checksums[`countries/${file}`] = checksum;

        let count = 0;
        let countryName = countryCode;

        // Large file optimization (> 5 MB): avoid loading entire file into memory
        let isLarge = false;
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 5 * 1024 * 1024) {
            isLarge = true;
          }
        } catch {}

        if (isLarge) {
          // Check if existing manifest matches checksum
          let reused = false;
          const manifestPath = this.getManifestFilePath();
          if (fs.existsSync(manifestPath)) {
            try {
              const existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              if (existingManifest.checksums?.[`countries/${file}`] === checksum) {
                const existingEntry = existingManifest.countryCoverage?.find((c: any) => c.code === countryCode);
                if (existingEntry) {
                  count = existingEntry.recordCount;
                  countryName = existingEntry.name;
                  reused = true;
                }
              }
            } catch {}
          }

          if (!reused) {
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
            coverageList.push({
              code: countryCode,
              name: countryCode,
              recordCount: 0
            });
          }
        }
      }
    }

    const indiaCitiesPath = this.getIndiaCitiesFilePath();
    if (fs.existsSync(indiaCitiesPath)) {
      checksums['india/cities.json'] = await LocationExporter.calculateFileChecksum(indiaCitiesPath);
    }

    const indiaStatesPath = this.getIndiaStatesFilePath();
    if (fs.existsSync(indiaStatesPath)) {
      checksums['india/states.json'] = await LocationExporter.calculateFileChecksum(indiaStatesPath);
    }

    // Include additional country-specific bulk partitioned directories (e.g. data/locations/us/cities.json)
    try {
      const subdirs = fs.readdirSync(this.dataDir, { withFileTypes: true });
      for (const entry of subdirs) {
        if (entry.isDirectory() && entry.name !== 'countries' && entry.name !== 'india' && !entry.name.startsWith('.')) {
          const pCities = path.join(this.dataDir, entry.name, 'cities.json');
          if (fs.existsSync(pCities)) {
            const relKey = `${entry.name}/cities.json`;
            checksums[relKey] = await LocationExporter.calculateFileChecksum(pCities);
            const stats = await LocationExporter.countRecordsInJsonFile(pCities);
            const cc = entry.name.toUpperCase();
            const existing = coverageList.find((c) => c.code === cc);
            if (existing) {
              existing.recordCount += stats.count;
            } else {
              coverageList.push({
                code: cc,
                name: stats.countryName || cc,
                recordCount: stats.count
              });
              totalRecords += stats.count;
            }
          }
          const pStates = path.join(this.dataDir, entry.name, 'states.json');
          if (fs.existsSync(pStates)) {
            const relKey = `${entry.name}/states.json`;
            checksums[relKey] = await LocationExporter.calculateFileChecksum(pStates);
          }
        }
      }
    } catch {}

    await this.writeCountriesIndex(coverageList);
    const countriesIndexPath = this.getCountriesIndexFilePath();
    if (fs.existsSync(countriesIndexPath)) {
      checksums['countries.json'] = await LocationExporter.calculateFileChecksum(countriesIndexPath);
    }

    let source = 'geonames';
    let license = 'Creative Commons Attribution 4.0 International (CC-BY 4.0)';
    let attribution = 'GeoNames (geonames.org)';

    const manifestPath = this.getManifestFilePath();
    if (fs.existsSync(manifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (existing.source === 'geonames') {
          source = existing.source;
          license = existing.license || license;
          attribution = existing.attribution || attribution;
        }
      } catch {
        // ignore read error
      }
    }

    const manifest: PipelineManifest = {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      source,
      license,
      attribution,
      totalRecords,
      countryCoverage: coverageList,
      status: 'completed',
      checksums
    };

    await this.writeManifest(manifest);
    return manifest;
  }

  /**
   * Generates countries.json index with coverage summaries.
   */
  public async writeCountriesIndex(coverage: CountryCoverage[]): Promise<string> {
    const filePath = this.getCountriesIndexFilePath();
    const tempPath = `${filePath}.tmp`;

    const sortedCoverage = [...coverage].sort((a, b) => a.name.localeCompare(b.name));
    const content = JSON.stringify(sortedCoverage, null, 2);

    fs.writeFileSync(tempPath, content, 'utf8');
    await LocationExporter.validateJsonFile(tempPath);
    fs.renameSync(tempPath, filePath);

    logger.debug({ countriesCount: sortedCoverage.length }, 'Wrote countries index file');
    return filePath;
  }

  /**
   * Generates manifest.json with checksums and run statistics.
   */
  public async writeManifest(manifest: PipelineManifest): Promise<string> {
    const filePath = this.getManifestFilePath();
    const tempPath = `${filePath}.tmp`;

    const content = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(tempPath, content, 'utf8');
    await LocationExporter.validateJsonFile(tempPath);
    fs.renameSync(tempPath, filePath);

    logger.debug({ totalRecords: manifest.totalRecords, status: manifest.status }, 'Wrote pipeline manifest');
    return filePath;
  }

  /**
   * Validates that a file contains syntactically valid JSON.
   */
  public static async validateJsonFile(filePath: string): Promise<boolean> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      throw new Error(`File is empty: ${filePath}`);
    }

    if (stats.size < 50 * 1024 * 1024) {
      const content = fs.readFileSync(filePath, 'utf8');
      try {
        JSON.parse(content);
        return true;
      } catch (err: any) {
        throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
      }
    }

    const firstChar = await LocationExporter.readFirstNonWhitespaceChar(filePath);
    const lastChar = await LocationExporter.readLastNonWhitespaceChar(filePath);

    if ((firstChar === '[' && lastChar === ']') || (firstChar === '{' && lastChar === '}')) {
      return true;
    }

    throw new Error(
      `Invalid JSON file envelope for large file ${filePath}: starts with '${firstChar}', ends with '${lastChar}'`
    );
  }

  private static async readFirstNonWhitespaceChar(filePath: string): Promise<string> {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 });
    for await (const chunk of stream) {
      const trimmed = chunk.trim();
      if (trimmed.length > 0) {
        stream.destroy();
        return trimmed[0];
      }
    }
    return '';
  }

  private static async readLastNonWhitespaceChar(filePath: string): Promise<string> {
    const stats = fs.statSync(filePath);
    const bufferSize = Math.min(1024, stats.size);
    const buffer = Buffer.alloc(bufferSize);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
      const text = buffer.toString('utf8').trim();
      return text.length > 0 ? text[text.length - 1] : '';
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Calculates SHA-256 checksum of an existing file.
   */
  public static calculateFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Streams a JSON array file to count records without holding all objects in memory.
   * Also extracts countryName from the first valid record.
   */
  public static async countRecordsInJsonFile(filePath: string): Promise<{ count: number; countryName: string }> {
    const readline = await import('node:readline');
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let count = 0;
    let countryName = '';

    try {
      for await (const line of rl) {
        const trimmed = line.trim().replace(/^,|,$/g, '');
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          count++;
          if (!countryName) {
            try {
              const parsed = JSON.parse(trimmed);
              countryName = parsed.countryName || '';
            } catch {}
          }
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    return { count, countryName };
  }
}
