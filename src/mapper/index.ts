import fs from 'node:fs';
import readline from 'node:readline';
import type { LocationRecord, RawGeoNameRecord } from '../types.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger({ module: 'mapper' });

// Default ISO country name fallback map for major countries
const DEFAULT_COUNTRIES: Record<string, string> = {
  IN: 'India',
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  JP: 'Japan',
  BR: 'Brazil',
  CN: 'China',
  IT: 'Italy',
  ES: 'Spain',
  RU: 'Russia',
  MX: 'Mexico',
  ZA: 'South Africa',
  NZ: 'New Zealand',
  SG: 'Singapore',
  AE: 'United Arab Emirates'
};

export class LocationMapper {
  private countryMap = new Map<string, string>(Object.entries(DEFAULT_COUNTRIES));
  private admin1Map = new Map<string, string>();

  /**
   * Loads country metadata from countryInfo.txt into the lookup cache.
   */
  public async loadCountryInfo(filePath: string): Promise<number> {
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, 'countryInfo.txt not found, using default country mappings');
      return this.countryMap.size;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    let count = 0;
    for await (const line of rl) {
      if (!line || line.startsWith('#') || line.trim().length === 0) {
        continue;
      }
      const parts = line.split('\t');
      const isoCode = parts[0]?.trim().toUpperCase();
      const countryName = parts[4]?.trim();

      if (isoCode && countryName) {
        this.countryMap.set(isoCode, countryName);
        count++;
      }
    }

    logger.info({ count }, 'Loaded country metadata');
    return count;
  }

  /**
   * Loads admin1 subdivision names from admin1CodesASCII.txt.
   * Format: <CountryCode>.<Admin1Code>\t<Name>\t<AsciiName>\t<geonameId>
   */
  public async loadAdmin1Codes(filePath: string): Promise<number> {
    if (!fs.existsSync(filePath)) {
      logger.warn({ filePath }, 'admin1CodesASCII.txt not found, continuing without admin1 names');
      return 0;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });

    let count = 0;
    for await (const line of rl) {
      if (!line || line.startsWith('#') || line.trim().length === 0) {
        continue;
      }
      const parts = line.split('\t');
      const codeKey = parts[0]?.trim(); // e.g. "IN.40" or "US.CA"
      const adminName = parts[1]?.trim();

      if (codeKey && adminName) {
        this.admin1Map.set(codeKey, adminName);
        count++;
      }
    }

    logger.info({ count }, 'Loaded administrative division level 1 names');
    return count;
  }

  /**
   * Sets manual lookup maps (useful for unit tests and custom configurations).
   */
  public setCountryMap(map: Map<string, string>): void {
    this.countryMap = new Map(map);
  }

  public setAdmin1Map(map: Map<string, string>): void {
    this.admin1Map = new Map(map);
  }

  /**
   * Maps a raw GeoNames record to a canonical LocationRecord.
   */
  public mapRecord(raw: RawGeoNameRecord, processedAtIso?: string): LocationRecord {
    const countryCode = raw.countryCode.toUpperCase();
    const countryName = this.countryMap.get(countryCode) || countryCode;

    const admin1Code = raw.admin1Code && raw.admin1Code.trim() !== '' ? raw.admin1Code.trim() : null;
    let admin1Name: string | null = null;
    if (admin1Code) {
      const lookupKey = `${countryCode}.${admin1Code}`;
      admin1Name = this.admin1Map.get(lookupKey) || null;
    }

    const admin2Code = raw.admin2Code && raw.admin2Code.trim() !== '' ? raw.admin2Code.trim() : null;

    const parsedPop = raw.population ? parseInt(raw.population, 10) : NaN;
    const population = !Number.isNaN(parsedPop) && parsedPop > 0 ? parsedPop : null;

    const parsedElev = raw.elevation ? parseInt(raw.elevation, 10) : NaN;
    const elevation = !Number.isNaN(parsedElev) ? parsedElev : null;

    const timezone = raw.timezone && raw.timezone.trim() !== '' ? raw.timezone.trim() : null;

    const alternateNames =
      raw.alternatenames && Array.isArray(raw.alternatenames)
        ? Array.from(
            new Set(
              raw.alternatenames
                .map((n) => n.trim())
                .filter((n) => n.length >= 2 && n.length <= 40 && !/^https?:\/\//i.test(n))
            )
          ).slice(0, 20)
        : undefined;

    return {
      id: raw.geonameid,
      name: raw.name,
      asciiName: raw.asciiname || raw.name,
      ...(alternateNames && alternateNames.length > 0 ? { alternateNames } : {}),
      countryCode,
      countryName,
      admin1Code,
      admin1Name,
      admin2Code,
      featureClass: raw.featureClass,
      featureCode: raw.featureCode,
      latitude: parseFloat(raw.latitude),
      longitude: parseFloat(raw.longitude),
      timezone,
      population,
      elevation,
      modificationDate: raw.modificationDate || new Date().toISOString().slice(0, 10),
      source: 'geonames',
      updatedAt: processedAtIso || new Date().toISOString()
    };
  }
}

export const defaultMapper = new LocationMapper();
export default defaultMapper;
