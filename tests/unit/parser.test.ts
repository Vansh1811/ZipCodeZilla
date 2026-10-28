import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGeoNameLine, streamGeoNames } from '../../src/parser/index.js';

describe('GeoNames Parser', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/sample-geonames.txt');

  it('correctly parses a single valid 19-column TSV line', () => {
    const line = '1269843\tHyderabad\tHyderabad\tHyderabad,Haiderabad\t17.38405\t78.45636\tP\tPPLA\tIN\t\t40\t\t\t\t6809970\t\t515\tAsia/Kolkata\t2024-01-15';
    const parsed = parseGeoNameLine(line, 1);

    expect(parsed).not.toBeNull();
    expect(parsed?.geonameid).toBe('1269843');
    expect(parsed?.name).toBe('Hyderabad');
    expect(parsed?.asciiname).toBe('Hyderabad');
    expect(parsed?.alternatenames).toEqual(['Hyderabad', 'Haiderabad']);
    expect(parsed?.latitude).toBe('17.38405');
    expect(parsed?.longitude).toBe('78.45636');
    expect(parsed?.featureClass).toBe('P');
    expect(parsed?.featureCode).toBe('PPLA');
    expect(parsed?.countryCode).toBe('IN');
    expect(parsed?.admin1Code).toBe('40');
    expect(parsed?.population).toBe('6809970');
    expect(parsed?.dem).toBe('515');
    expect(parsed?.timezone).toBe('Asia/Kolkata');
    expect(parsed?.modificationDate).toBe('2024-01-15');
    expect(parsed?.lineNumber).toBe(1);
  });

  it('skips empty or comment lines', () => {
    expect(parseGeoNameLine('', 1)).toBeNull();
    expect(parseGeoNameLine('   ', 2)).toBeNull();
    expect(parseGeoNameLine('# comment', 3)).toBeNull();
  });

  it('returns null for lines with fewer than 19 columns', () => {
    expect(parseGeoNameLine('col1\tcol2\tcol3', 4)).toBeNull();
  });

  it('streams records from file skipping comments and malformed lines', async () => {
    const records = [];
    for await (const record of streamGeoNames(fixturePath)) {
      records.push(record);
    }

    // 10 lines in fixture: 1 malformed line should be skipped, leaving 9
    expect(records.length).toBe(9);
    expect(records[0].name).toBe('Hyderabad');
    expect(records[1].name).toBe('New York City');
    expect(records[2].name).toBe('London');
  });
});
