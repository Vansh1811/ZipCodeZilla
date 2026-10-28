import fs from 'node:fs';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import type { RawGeoNameRecord } from '../types.js';
import { createLogger } from '../logger/index.js';

const logger = createLogger({ module: 'parser' });

export interface ParserOptions {
  skipMalformed?: boolean;
}

/**
 * Parses a single tab-separated line from GeoNames data.
 */
export function parseGeoNameLine(line: string, lineNumber: number): RawGeoNameRecord | null {
  if (!line || line.startsWith('#') || line.trim().length === 0) {
    return null;
  }

  const parts = line.split('\t');
  if (parts.length < 19) {
    return null;
  }

  return {
    geonameid: parts[0]?.trim() || '',
    name: parts[1]?.trim() || '',
    asciiname: parts[2]?.trim() || '',
    alternatenames: parts[3] ? parts[3].split(',').map((s) => s.trim()).filter(Boolean) : [],
    latitude: parts[4]?.trim() || '',
    longitude: parts[5]?.trim() || '',
    featureClass: parts[6]?.trim().toUpperCase() || '',
    featureCode: parts[7]?.trim().toUpperCase() || '',
    countryCode: parts[8]?.trim().toUpperCase() || '',
    cc2: parts[9] ? parts[9].split(',').map((s) => s.trim()).filter(Boolean) : [],
    admin1Code: parts[10]?.trim() || '',
    admin2Code: parts[11]?.trim() || '',
    admin3Code: parts[12]?.trim() || '',
    admin4Code: parts[13]?.trim() || '',
    population: parts[14]?.trim() || '',
    elevation: parts[15]?.trim() || '',
    dem: parts[16]?.trim() || '',
    timezone: parts[17]?.trim() || '',
    modificationDate: parts[18]?.trim() || '',
    lineNumber
  };
}

/**
 * Streams and parses a GeoNames TSV file or Readable stream line by line.
 */
export async function* streamGeoNames(
  source: string | Readable,
  options: ParserOptions = { skipMalformed: true }
): AsyncGenerator<RawGeoNameRecord, void, unknown> {
  const stream: Readable =
    typeof source === 'string'
      ? fs.createReadStream(source, { encoding: 'utf8' })
      : source;

  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let lineNumber = 0;
  let malformedCount = 0;

  for await (const line of rl) {
    lineNumber++;
    if (!line || line.startsWith('#') || line.trim().length === 0) {
      continue;
    }

    const record = parseGeoNameLine(line, lineNumber);
    if (!record) {
      malformedCount++;
      if (!options.skipMalformed) {
        throw new Error(`Malformed GeoNames record at line ${lineNumber}: insufficient columns`);
      }
      if (malformedCount <= 10 || malformedCount % 10000 === 0) {
        logger.warn({ lineNumber, malformedCount }, 'Skipped malformed line (insufficient columns)');
      }
      continue;
    }

    yield record;
  }

  if (malformedCount > 0) {
    logger.info({ totalLines: lineNumber, malformedCount }, 'Finished stream parsing with skipped lines');
  }
}
