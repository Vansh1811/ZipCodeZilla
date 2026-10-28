import type { LocationRecord, RawGeoNameRecord, ValidationResult, ValidationStats } from '../types.js';

export class LocationValidator {
  private stats: ValidationStats = {
    passed: 0,
    failed: 0,
    errorsByType: {}
  };

  /**
   * Validates a mapped LocationRecord.
   */
  public validateLocation(record: LocationRecord): ValidationResult {
    const errors: string[] = [];

    // ID validation
    if (!record.id || typeof record.id !== 'string' || record.id.trim() === '') {
      errors.push('Missing or empty ID');
    }

    // Name validation
    if (!record.name || typeof record.name !== 'string' || record.name.trim() === '') {
      errors.push('Missing or empty name');
    }

    // Country code validation (2 uppercase letters)
    if (!record.countryCode || !/^[A-Z]{2}$/.test(record.countryCode)) {
      errors.push(`Invalid countryCode: "${record.countryCode}" (expected 2 uppercase letters)`);
    }

    // Coordinates validation
    if (typeof record.latitude !== 'number' || Number.isNaN(record.latitude)) {
      errors.push('Latitude must be a valid number');
    } else if (record.latitude < -90 || record.latitude > 90) {
      errors.push(`Latitude out of range [-90, 90]: ${record.latitude}`);
    }

    if (typeof record.longitude !== 'number' || Number.isNaN(record.longitude)) {
      errors.push('Longitude must be a valid number');
    } else if (record.longitude < -180 || record.longitude > 180) {
      errors.push(`Longitude out of range [-180, 180]: ${record.longitude}`);
    }

    // Feature class and code (optional, must be non-empty if present)
    if (record.featureClass !== null && record.featureClass !== undefined && (typeof record.featureClass !== 'string' || record.featureClass.trim() === '')) {
      errors.push('featureClass must be null or a non-empty string');
    }

    if (record.featureCode !== null && record.featureCode !== undefined && (typeof record.featureCode !== 'string' || record.featureCode.trim() === '')) {
      errors.push('featureCode must be null or a non-empty string');
    }

    // Timezone validation (if present, must be non-empty)
    if (record.timezone !== null && (typeof record.timezone !== 'string' || record.timezone.trim() === '')) {
      errors.push('Timezone must be null or a non-empty string');
    }

    // Population validation (if present, must be non-negative)
    if (record.population !== null && (typeof record.population !== 'number' || record.population < 0)) {
      errors.push('Population must be null or a non-negative number');
    }

    const valid = errors.length === 0;
    if (valid) {
      this.stats.passed++;
    } else {
      this.stats.failed++;
      for (const err of errors) {
        this.stats.errorsByType[err] = (this.stats.errorsByType[err] || 0) + 1;
      }
    }

    return { valid, errors };
  }

  /**
   * Quick preliminary validation on a RawGeoNameRecord before full mapping.
   */
  public validateRaw(raw: RawGeoNameRecord): ValidationResult {
    const errors: string[] = [];

    if (!raw.geonameid || raw.geonameid.trim() === '') {
      errors.push('Missing geonameid');
    }
    if (!raw.name || raw.name.trim() === '') {
      errors.push('Missing name');
    }
    if (!raw.countryCode || !/^[A-Z]{2}$/.test(raw.countryCode)) {
      errors.push(`Invalid countryCode: "${raw.countryCode}"`);
    }

    const lat = parseFloat(raw.latitude);
    if (Number.isNaN(lat) || lat < -90 || lat > 90) {
      errors.push(`Invalid latitude: "${raw.latitude}"`);
    }

    const lng = parseFloat(raw.longitude);
    if (Number.isNaN(lng) || lng < -180 || lng > 180) {
      errors.push(`Invalid longitude: "${raw.longitude}"`);
    }

    return { valid: errors.length === 0, errors };
  }

  public getStats(): ValidationStats {
    return {
      passed: this.stats.passed,
      failed: this.stats.failed,
      errorsByType: { ...this.stats.errorsByType }
    };
  }

  public resetStats(): void {
    this.stats = {
      passed: 0,
      failed: 0,
      errorsByType: {}
    };
  }
}

export const defaultValidator = new LocationValidator();
export default defaultValidator;
