import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import type { LocationRecord } from '../types.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger({ module: 'local-resolver' });

export interface LocalResolverOptions {
  dataDir?: string;
  maxCacheSize?: number;
}

/**
 * Normalizes location names for case-insensitive and accent-insensitive matching.
 */
export function normalizeLocationName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Administrative importance hierarchy score for disambiguation.
 * Capital of country (PPLC) > State capital (PPLA) > District head (PPLA2) > Populated place (PPL).
 */
export function getFeatureScore(featureCode: string | null): number {
  if (!featureCode) return 10;
  switch (featureCode.toUpperCase()) {
    case 'PPLC':
      return 100; // Capital of a political entity (e.g. New Delhi, Washington, London, Tokyo, Paris, Beijing)
    case 'PPLA':
      return 90; // Seat of a first-order administrative division (e.g. Mumbai, Bengaluru, New York, Sydney)
    case 'PPLA2':
      return 80; // Seat of a second-order administrative division (e.g. district/county HQ)
    case 'PPLA3':
      return 70; // Seat of a third-order administrative division
    case 'PPLA4':
      return 60; // Seat of a fourth-order administrative division
    case 'PPL':
      return 50; // Populated place (city, town, village)
    case 'PPLX':
      return 40; // Section of populated place
    case 'ADM1':
      return 35; // First-order administrative division (state/province)
    case 'ADM2':
      return 30; // Second-order division (district/county)
    default:
      return 10;
  }
}

/**
 * Common colloquial, colonial, and alternate aliases for seamless local resolution.
 */
export const KNOWN_ALIASES: Record<string, string> = {
  // India historical / colloquial city names
  bombay: 'mumbai',
  bangalore: 'bengaluru',
  calcutta: 'kolkata',
  madras: 'chennai',
  poona: 'pune',
  baroda: 'vadodara',
  trivandrum: 'thiruvananthapuram',
  cochin: 'kochi',
  calicut: 'kozhikode',
  gurgaon: 'gurugram',
  mysore: 'mysuru',
  pondicherry: 'puducherry',
  orissa: 'odisha',
  banaras: 'varanasi',
  benares: 'varanasi',
  // Worldwide common colloquial / short city names
  'new york': 'new york city',
  peking: 'beijing',
  canton: 'guangzhou',
  saigon: 'ho chi minh city'
};

/**
 * Disambiguates multiple matching location candidates:
 * 1. Filter match by explicitly requested country (if provided).
 * 2. Exact normalized name match.
 * 3. Exact alternate name match.
 * 4. Administrative prominence tier.
 * 5. Highest population count.
 * 6. Deterministic tie-breaking.
 */
export function rankCandidates(
  candidates: LocationRecord[],
  targetName: string,
  requestedCountry?: string
): LocationRecord {
  if (candidates.length === 1) {
    return candidates[0];
  }

  const normTarget = normalizeLocationName(targetName);
  const normReqCountry = requestedCountry ? requestedCountry.trim().toUpperCase() : undefined;

  const sorted = [...candidates].sort((a, b) => {
    // 0. Requested country match if provided
    if (normReqCountry) {
      const aCountry = a.countryCode?.toUpperCase() === normReqCountry;
      const bCountry = b.countryCode?.toUpperCase() === normReqCountry;
      if (aCountry && !bCountry) return -1;
      if (!aCountry && bCountry) return 1;
    }

    // 1. Exact match on name or asciiName
    const aExact =
      normalizeLocationName(a.name) === normTarget ||
      normalizeLocationName(a.asciiName) === normTarget;
    const bExact =
      normalizeLocationName(b.name) === normTarget ||
      normalizeLocationName(b.asciiName) === normTarget;

    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;

    // 1b. If neither has an exact primary name match, check exact match on alternateNames
    if (!aExact && !bExact) {
      const aAltExact = a.alternateNames?.some((alt) => normalizeLocationName(alt) === normTarget) ?? false;
      const bAltExact = b.alternateNames?.some((alt) => normalizeLocationName(alt) === normTarget) ?? false;
      if (aAltExact && !bAltExact) return -1;
      if (!aAltExact && bAltExact) return 1;
    }

    // 2. Feature score hierarchy (e.g. PPLC national capital > PPLA state capital > PPLA2 district > PPL)
    const scoreA = getFeatureScore(a.featureCode);
    const scoreB = getFeatureScore(b.featureCode);
    if (scoreA !== scoreB) {
      // National capitals (PPLC) always take precedence
      if (a.featureCode === 'PPLC') return -1;
      if (b.featureCode === 'PPLC') return 1;

      // If one candidate has vastly higher population (> 100k and > 5x), population takes precedence
      const popA = a.population ?? 0;
      const popB = b.population ?? 0;
      if (popA > 100000 && popA > popB * 5) return -1;
      if (popB > 100000 && popB > popA * 5) return 1;

      return scoreB - scoreA;
    }

    // 3. Population descending (higher population breaks ties)
    const popA = a.population ?? 0;
    const popB = b.population ?? 0;
    if (popA !== popB) {
      return popB - popA;
    }

    // 4. Country priority: if equal and no country was requested, prioritize IN (India-first requirement)
    if (!normReqCountry && a.countryCode !== b.countryCode) {
      if (a.countryCode === 'IN') return -1;
      if (b.countryCode === 'IN') return 1;
    }

    // 5. Fallback: ID stability
    return a.id.localeCompare(b.id);
  });

  return sorted[0];
}

/**
 * Resolver for local offline GeoNames datasets.
 * Supports country-partitioned data access across India (comprehensive) and worldwide countries (major places).
 * Performs memory-bounded streaming searches and prefix offset index queries without loading large files into heap.
 * Caches resolved records in-memory for zero-latency subsequent queries.
 */
export class LocalGeoNamesResolver {
  private dataDir: string;
  private maxCacheSize: number;

  // In-memory cache of resolved queries: normalizedKey -> LocationRecord
  private resolvedCache = new Map<string, LocationRecord>();

  // In-memory negative cache: normalizedKey -> boolean (avoids repeated file streaming for missing locations)
  private negativeCache = new Set<string>();

  // In-memory index of administrative states/districts by country: countryCode -> (name -> LocationRecord[])
  private statesIndex = new Map<string, Map<string, LocationRecord[]>>();
  private statesLoaded = new Set<string>();

  // In-memory cache of parsed prefix files (bounded to 200 prefixes, ~3 MB heap)
  // Key format: `${countryCode}:${prefix}`
  private prefixCache = new Map<string, Record<string, [number, number][]>>();

  // Mutex promises to avoid duplicate concurrent index builds per country
  private buildIndexPromises = new Map<string, Promise<void>>();

  constructor(options?: LocalResolverOptions) {
    this.dataDir = options?.dataDir ?? path.resolve('data/locations');
    this.maxCacheSize = options?.maxCacheSize ?? 10000;
  }

  public getCountryDir(countryCode: string = 'IN'): string {
    const code = countryCode.toUpperCase();
    if (code === 'IN') {
      return path.join(this.dataDir, 'india');
    }
    return path.join(this.dataDir, code.toLowerCase());
  }

  public getIndexDir(countryCode: string = 'IN'): string {
    return path.join(this.getCountryDir(countryCode), '.index');
  }

  public getDataFilePath(countryCode: string = 'IN'): string | null {
    const code = countryCode.toUpperCase();
    const cDir = this.getCountryDir(code);
    const citiesPath = path.join(cDir, 'cities.json');
    if (fs.existsSync(citiesPath)) {
      return citiesPath;
    }
    const countryFilePath = path.join(this.dataDir, 'countries', `${code}.json`);
    if (fs.existsSync(countryFilePath)) {
      return countryFilePath;
    }
    return null;
  }

  public hasIndex(countryCode: string = 'IN'): boolean {
    const indexDir = this.getIndexDir(countryCode);
    if (!fs.existsSync(indexDir)) {
      return false;
    }
    try {
      const files = fs.readdirSync(indexDir);
      if (files.length === 0) {
        return false;
      }
      const dataPath = this.getDataFilePath(countryCode);
      if (dataPath && fs.existsSync(dataPath)) {
        const dataMtime = fs.statSync(dataPath).mtimeMs;
        const indexMtime = fs.statSync(indexDir).mtimeMs;
        if (dataMtime > indexMtime) {
          logger.warn({ countryCode }, 'Country dataset is newer than offset index; index will be rebuilt');
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discovers all country ISO codes with local datasets available on disk.
   */
  public getAvailableCountries(): string[] {
    const countries = new Set<string>();

    // 1. India check
    const indiaCities = path.join(this.dataDir, 'india', 'cities.json');
    if (fs.existsSync(indiaCities)) {
      countries.add('IN');
    }

    // 2. Subdirectories under dataDir (e.g. data/locations/us/cities.json)
    try {
      if (fs.existsSync(this.dataDir)) {
        const entries = fs.readdirSync(this.dataDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== 'countries' && entry.name !== 'india' && !entry.name.startsWith('.')) {
            const cPath = path.join(this.dataDir, entry.name, 'cities.json');
            if (fs.existsSync(cPath)) {
              countries.add(entry.name.toUpperCase());
            }
          }
        }
      }
    } catch {}

    // 3. Large bulk files in countries/
    try {
      const countriesDir = path.join(this.dataDir, 'countries');
      if (fs.existsSync(countriesDir)) {
        const files = fs.readdirSync(countriesDir).filter((f) => f.endsWith('.json') && !f.endsWith('.cache.json'));
        for (const file of files) {
          const code = path.basename(file, '.json').toUpperCase();
          const filePath = path.join(countriesDir, file);
          const stat = fs.statSync(filePath);
          if (stat.size > 5 * 1024 * 1024) {
            countries.add(code);
          }
        }
      }
    } catch {}

    const result = Array.from(countries);
    // Put IN first if present
    result.sort((a, b) => {
      if (a === 'IN') return -1;
      if (b === 'IN') return 1;
      return a.localeCompare(b);
    });
    return result;
  }

  /**
   * Builds high-performance prefix offset index for a country dataset.
   * Stores byte offset pairs [lineStart, lineLength] partitioned by 2-character prefix.
   */
  public async buildIndex(countryCode: string = 'IN'): Promise<void> {
    const code = countryCode.toUpperCase();
    if (this.hasIndex(code)) {
      return;
    }

    const existingPromise = this.buildIndexPromises.get(code);
    if (existingPromise) {
      return existingPromise;
    }

    const buildPromise = this.executeBuildIndex(code);
    this.buildIndexPromises.set(code, buildPromise);
    try {
      await buildPromise;
    } finally {
      this.buildIndexPromises.delete(code);
    }
  }

  private async executeBuildIndex(countryCode: string): Promise<void> {
    if (this.hasIndex(countryCode)) {
      return;
    }
    const dataPath = this.getDataFilePath(countryCode);
    if (!dataPath || !fs.existsSync(dataPath)) {
      return;
    }

    const indexDir = this.getIndexDir(countryCode);
    const tempIndexDir = `${indexDir}.tmp-${Date.now()}`;
    if (!fs.existsSync(tempIndexDir)) {
      fs.mkdirSync(tempIndexDir, { recursive: true });
    }

    const stream = fs.createReadStream(dataPath, { highWaterMark: 1024 * 1024 });
    let globalOffset = 0;
    let lineStart = 0;
    let leftover = Buffer.alloc(0);
    const prefixMaps = new Map<string, Map<string, [number, number][]>>();

    try {
      for await (const chunk of stream) {
        let start = 0;
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] === 0x0a) {
            const lineLen = globalOffset + i - lineStart;
            let lineBuf: Buffer;
            if (leftover.length > 0) {
              lineBuf = Buffer.concat([leftover, chunk.subarray(start, i)]);
              leftover = Buffer.alloc(0);
            } else {
              lineBuf = chunk.subarray(start, i);
            }

            const lineStr = lineBuf.toString('utf8').trim().replace(/^,|,$/g, '');
            if (lineStr.startsWith('{') && lineStr.endsWith('}')) {
              try {
                const obj = JSON.parse(lineStr) as LocationRecord;
                if (!obj.source || obj.source === 'geonames') {
                  const n1 = normalizeLocationName(obj.name);
                  if (n1) {
                    const p1 = (n1.slice(0, 2) || '__').replace(/[^a-z0-9]/g, '_');
                    let m1 = prefixMaps.get(p1);
                    if (!m1) {
                      m1 = new Map();
                      prefixMaps.set(p1, m1);
                    }
                    let list1 = m1.get(n1);
                    if (!list1) {
                      list1 = [];
                      m1.set(n1, list1);
                    }
                    list1.push([lineStart, lineLen]);
                  }

                  if (obj.asciiName) {
                    const n2 = normalizeLocationName(obj.asciiName);
                    if (n2 && n2 !== normalizeLocationName(obj.name)) {
                      const p2 = (n2.slice(0, 2) || '__').replace(/[^a-z0-9]/g, '_');
                      let m2 = prefixMaps.get(p2);
                      if (!m2) {
                        m2 = new Map();
                        prefixMaps.set(p2, m2);
                      }
                      let list2 = m2.get(n2);
                      if (!list2) {
                        list2 = [];
                        m2.set(n2, list2);
                      }
                      list2.push([lineStart, lineLen]);
                    }
                  }

                  if (obj.alternateNames && Array.isArray(obj.alternateNames)) {
                    for (const alt of obj.alternateNames) {
                      const nAlt = normalizeLocationName(alt);
                      if (
                        nAlt &&
                        nAlt.length >= 2 &&
                        nAlt !== n1 &&
                        (!obj.asciiName || nAlt !== normalizeLocationName(obj.asciiName))
                      ) {
                        const pAlt = (nAlt.slice(0, 2) || '__').replace(/[^a-z0-9]/g, '_');
                        let mAlt = prefixMaps.get(pAlt);
                        if (!mAlt) {
                          mAlt = new Map();
                          prefixMaps.set(pAlt, mAlt);
                        }
                        let listAlt = mAlt.get(nAlt);
                        if (!listAlt) {
                          listAlt = [];
                          mAlt.set(nAlt, listAlt);
                        }
                        listAlt.push([lineStart, lineLen]);
                      }
                    }
                  }
                }
              } catch {
                // ignore malformed lines
              }
            }

            lineStart = globalOffset + i + 1;
            start = i + 1;
          }
        }
        if (start < chunk.length) {
          leftover = Buffer.from(chunk.subarray(start));
        }
        globalOffset += chunk.length;
      }

      // Write prefix files atomically to temp directory
      for (const [prefix, map] of prefixMaps.entries()) {
        const outObj: Record<string, [number, number][]> = {};
        for (const [name, offsets] of map.entries()) {
          outObj[name] = offsets;
        }
        fs.writeFileSync(path.join(tempIndexDir, `${prefix}.json`), JSON.stringify(outObj), 'utf8');
      }

      // Atomically move temp directory to final index directory
      if (fs.existsSync(indexDir)) {
        fs.rmSync(indexDir, { recursive: true, force: true });
      }
      fs.renameSync(tempIndexDir, indexDir);

      // Clear prefix cache for this country
      for (const key of this.prefixCache.keys()) {
        if (key.startsWith(`${countryCode}:`)) {
          this.prefixCache.delete(key);
        }
      }
      logger.info({ countryCode, totalPrefixes: prefixMaps.size }, 'Successfully built country offset index');
    } catch (err: any) {
      logger.error({ countryCode, error: err.message }, 'Failed building country offset index');
      if (fs.existsSync(tempIndexDir)) {
        try {
          fs.rmSync(tempIndexDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  /**
   * Builds the lookup key for local cache storage.
   */
  public static buildKey(cityName: string, countryCode?: string): string {
    const normCity = normalizeLocationName(cityName);
    const normCountry = (countryCode || '').trim().toUpperCase();
    return normCountry ? `${normCountry}:${normCity}` : normCity;
  }

  /**
   * Finds a location from the local imported GeoNames datasets.
   * If countryCode is supplied, restricts search to that country partition.
   * If countryCode is omitted, searches across all locally available country partitions and ranks candidates.
   */
  public async findLocation(cityName: string, countryCode?: string): Promise<LocationRecord | null> {
    const normCity = normalizeLocationName(cityName);
    if (!normCity) {
      return null;
    }

    const normCountry = countryCode ? countryCode.trim().toUpperCase() : undefined;
    const cacheKey = LocalGeoNamesResolver.buildKey(normCity, normCountry);

    // Check in-memory resolved cache
    if (this.resolvedCache.has(cacheKey)) {
      return this.resolvedCache.get(cacheKey) || null;
    }

    // Check negative cache
    if (this.negativeCache.has(cacheKey)) {
      return null;
    }

    // Case 1: Specific country requested
    if (normCountry) {
      const alias = KNOWN_ALIASES[normCity];
      const targetQuery = alias || cityName;
      const match = await this.searchCountry(targetQuery, normCountry);
      if (match) {
        this.cacheResult(cacheKey, match);
        return match;
      }
      if (alias && alias !== cityName) {
        const directMatch = await this.searchCountry(cityName, normCountry);
        if (directMatch) {
          this.cacheResult(cacheKey, directMatch);
          return directMatch;
        }
      }
      this.recordNegative(cacheKey);
      return null;
    }

    // Case 2: No country filter provided -> Search across all locally available countries
    const available = this.getAvailableCountries();
    const candidateMatches: LocationRecord[] = [];
    const alias = KNOWN_ALIASES[normCity];
    const targetQuery = alias || cityName;

    for (const code of available) {
      const match = await this.searchCountry(targetQuery, code);
      if (match) {
        candidateMatches.push(match);
      }
    }

    if (candidateMatches.length > 0) {
      const best = rankCandidates(candidateMatches, targetQuery);
      this.cacheResult(cacheKey, best);
      return best;
    }

    if (alias && alias !== cityName) {
      for (const code of available) {
        const match = await this.searchCountry(cityName, code);
        if (match) {
          candidateMatches.push(match);
        }
      }
      if (candidateMatches.length > 0) {
        const best = rankCandidates(candidateMatches, cityName);
        this.cacheResult(cacheKey, best);
        return best;
      }
    }

    this.recordNegative(cacheKey);
    return null;
  }

  /**
   * Resolves a query within a specific country's local partition.
   */
  public async searchCountry(cityName: string, countryCode: string): Promise<LocationRecord | null> {
    const code = countryCode.toUpperCase();
    const dataPath = this.getDataFilePath(code);

    // 1. Search populated places / cities dataset if available
    if (dataPath && fs.existsSync(dataPath)) {
      // Use precomputed index if present
      if (this.hasIndex(code)) {
        const match = this.searchCitiesIndex(cityName, dataPath, code);
        if (match) return match;
      } else {
        // Build index automatically if file > 5MB
        try {
          const stat = fs.statSync(dataPath);
          if (stat.size > 5 * 1024 * 1024) {
            logger.info({ countryCode: code }, 'Building high-performance disk index for country dataset...');
            await this.buildIndex(code);
            if (this.hasIndex(code)) {
              const match = this.searchCitiesIndex(cityName, dataPath, code);
              if (match) return match;
            }
          }
        } catch {}

        // Fallback: memory-bounded streaming search
        const match = await this.searchCitiesStream(cityName, dataPath, code);
        if (match) return match;
      }
    }

    // 2. Search administrative divisions / states dataset
    const stateMatch = this.searchStatesIndex(cityName, code);
    if (stateMatch) {
      return stateMatch;
    }

    return null;
  }

  /**
   * Searches cities using high-performance prefix offset index.
   * Reads only small prefix file (~20 KB) and fetches candidate byte ranges directly from file.
   */
  private searchCitiesIndex(cityName: string, dataFilePath: string, countryCode: string): LocationRecord | null {
    const normTarget = normalizeLocationName(cityName);
    const prefix = (normTarget.slice(0, 2) || '__').replace(/[^a-z0-9]/g, '_');
    const indexDir = this.getIndexDir(countryCode);
    const indexFilePath = path.join(indexDir, `${prefix}.json`);

    if (!fs.existsSync(indexFilePath)) {
      return null;
    }

    const cacheKey = `${countryCode}:${prefix}`;
    let prefixMap: Record<string, [number, number][]>;

    if (this.prefixCache.has(cacheKey)) {
      prefixMap = this.prefixCache.get(cacheKey)!;
    } else {
      try {
        prefixMap = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
        if (this.prefixCache.size >= 200) {
          const firstKey = this.prefixCache.keys().next().value;
          if (firstKey) this.prefixCache.delete(firstKey);
        }
        this.prefixCache.set(cacheKey, prefixMap);
      } catch {
        return null;
      }
    }

    const offsets = prefixMap[normTarget];
    if (!offsets || offsets.length === 0) {
      return null;
    }

    const candidates: LocationRecord[] = [];
    let fd: number | null = null;
    try {
      fd = fs.openSync(dataFilePath, 'r');
      for (const [offset, len] of offsets) {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        const lineStr = buf.toString('utf8').trim().replace(/^,|,$/g, '');
        const record = JSON.parse(lineStr) as LocationRecord;
        if (!record.source || record.source === 'geonames') {
          candidates.push(record);
        }
      }
    } catch (err: any) {
      logger.warn({ cityName, countryCode, error: err.message }, 'Failed reading candidate from offset index');
      return null;
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    return rankCandidates(candidates, cityName, countryCode);
  }

  /**
   * Streams country data line-by-line without loading large files into memory.
   */
  private async searchCitiesStream(cityName: string, dataFilePath: string, countryCode?: string): Promise<LocationRecord | null> {
    if (!fs.existsSync(dataFilePath)) {
      return null;
    }

    const normTarget = normalizeLocationName(cityName);
    const candidates: LocationRecord[] = [];

    const fileStream = fs.createReadStream(dataFilePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let objBuffer = '';
    let isBuffering = false;

    try {
      for await (const line of rl) {
        const trimmed = line.trim();

        if (!isBuffering) {
          const clean = trimmed.replace(/^,|,$/g, '');
          if (clean.startsWith('{') && clean.endsWith('}')) {
            if (line.toLowerCase().includes(normTarget)) {
              try {
                const record = JSON.parse(clean) as LocationRecord;
                if (record.source && record.source !== 'geonames') {
                  continue;
                }
                const matchName = normalizeLocationName(record.name) === normTarget;
                const matchAscii =
                  record.asciiName && normalizeLocationName(record.asciiName) === normTarget;
                const matchAlt =
                  record.alternateNames &&
                  record.alternateNames.some((alt) => normalizeLocationName(alt) === normTarget);

                if (matchName || matchAscii || matchAlt) {
                  candidates.push(record);
                }
              } catch {}
            }
          } else if (trimmed.startsWith('{')) {
            isBuffering = true;
            objBuffer = trimmed;
          }
        } else {
          objBuffer += '\n' + trimmed;
          const cleanBuffer = objBuffer.trim().replace(/^,|,$/g, '');
          if (cleanBuffer.endsWith('}')) {
            isBuffering = false;
            if (objBuffer.toLowerCase().includes(normTarget)) {
              try {
                const record = JSON.parse(cleanBuffer) as LocationRecord;
                if (record.source && record.source !== 'geonames') {
                  continue;
                }
                const matchName = normalizeLocationName(record.name) === normTarget;
                const matchAscii =
                  record.asciiName && normalizeLocationName(record.asciiName) === normTarget;
                const matchAlt =
                  record.alternateNames &&
                  record.alternateNames.some((alt) => normalizeLocationName(alt) === normTarget);

                if (matchName || matchAscii || matchAlt) {
                  candidates.push(record);
                }
              } catch {}
            }
            objBuffer = '';
          }
        }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    if (candidates.length === 0) {
      return null;
    }

    return rankCandidates(candidates, cityName, countryCode);
  }

  /**
   * Searches the states index for administrative divisions (e.g. "Maharashtra", "Tamil Nadu", "California").
   */
  private searchStatesIndex(cityName: string, countryCode: string = 'IN'): LocationRecord | null {
    const code = countryCode.toUpperCase();
    this.ensureStatesLoaded(code);

    const countryMap = this.statesIndex.get(code);
    if (!countryMap) {
      return null;
    }

    const normTarget = normalizeLocationName(cityName);
    const matches = countryMap.get(normTarget);
    if (!matches || matches.length === 0) {
      return null;
    }

    const geonamesMatches = matches.filter((r) => !r.source || r.source === 'geonames');
    if (geonamesMatches.length === 0) {
      return null;
    }

    return rankCandidates(geonamesMatches, cityName, code);
  }

  /**
   * Lazily loads and indexes administrative divisions for a country.
   */
  private ensureStatesLoaded(countryCode: string = 'IN'): void {
    const code = countryCode.toUpperCase();
    if (this.statesLoaded.has(code)) {
      return;
    }
    this.statesLoaded.add(code);

    let statesPath = path.join(this.getCountryDir(code), 'states.json');
    if (!fs.existsSync(statesPath) && code === 'IN') {
      statesPath = path.join(this.dataDir, 'india', 'states.json');
    }

    if (!fs.existsSync(statesPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(statesPath, 'utf8');
      const records = JSON.parse(content) as LocationRecord[];
      let countryMap = this.statesIndex.get(code);
      if (!countryMap) {
        countryMap = new Map();
        this.statesIndex.set(code, countryMap);
      }

      for (const record of records) {
        this.indexStateRecord(countryMap, normalizeLocationName(record.name), record);
        if (record.asciiName && record.asciiName !== record.name) {
          this.indexStateRecord(countryMap, normalizeLocationName(record.asciiName), record);
        }
        if (record.admin1Name && (record.featureCode === 'ADM1' || record.featureClass === 'A')) {
          this.indexStateRecord(countryMap, normalizeLocationName(record.admin1Name), record);
        }
      }

      logger.debug({ countryCode: code, totalStates: records.length }, 'Loaded country states index');
    } catch (err: any) {
      logger.error({ countryCode: code, error: err.message }, 'Failed loading states.json index');
    }
  }

  private indexStateRecord(map: Map<string, LocationRecord[]>, key: string, record: LocationRecord): void {
    const list = map.get(key) || [];
    list.push(record);
    map.set(key, list);
  }

  private cacheResult(key: string, record: LocationRecord): void {
    if (this.resolvedCache.size >= this.maxCacheSize) {
      const oldestKey = this.resolvedCache.keys().next().value;
      if (oldestKey) this.resolvedCache.delete(oldestKey);
    }
    this.resolvedCache.set(key, record);
  }

  private recordNegative(key: string): void {
    if (this.negativeCache.size >= this.maxCacheSize) {
      const firstKey = this.negativeCache.values().next().value;
      if (firstKey) this.negativeCache.delete(firstKey);
    }
    this.negativeCache.add(key);
  }

  /**
   * Clears in-memory caches (useful for testing).
   */
  public clearCache(): void {
    this.resolvedCache.clear();
    this.negativeCache.clear();
    this.statesIndex.clear();
    this.statesLoaded.clear();
    this.prefixCache.clear();
  }
}
