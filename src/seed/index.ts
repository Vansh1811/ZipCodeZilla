import { createLogger } from '../logger/index.js';
import { LocationCacheService, defaultCacheService } from '../cache/index.js';

const logger = createLogger({ module: 'seed' });

export interface SeedCity {
  city: string;
  countryCode: string;
}

export const SEED_LOCATIONS: SeedCity[] = [
  // India - Metropolitan, State Capitals & Major Populated Places
  { city: 'New Delhi', countryCode: 'IN' },
  { city: 'Mumbai', countryCode: 'IN' },
  { city: 'Bengaluru', countryCode: 'IN' },
  { city: 'Hyderabad', countryCode: 'IN' },
  { city: 'Chennai', countryCode: 'IN' },
  { city: 'Kolkata', countryCode: 'IN' },
  { city: 'Ahmedabad', countryCode: 'IN' },
  { city: 'Pune', countryCode: 'IN' },
  { city: 'Surat', countryCode: 'IN' },
  { city: 'Jaipur', countryCode: 'IN' },
  { city: 'Lucknow', countryCode: 'IN' },
  { city: 'Kanpur', countryCode: 'IN' },
  { city: 'Nagpur', countryCode: 'IN' },
  { city: 'Indore', countryCode: 'IN' },
  { city: 'Thane', countryCode: 'IN' },
  { city: 'Bhopal', countryCode: 'IN' },
  { city: 'Visakhapatnam', countryCode: 'IN' },
  { city: 'Patna', countryCode: 'IN' },
  { city: 'Vadodara', countryCode: 'IN' },
  { city: 'Ghaziabad', countryCode: 'IN' },
  { city: 'Ludhiana', countryCode: 'IN' },
  { city: 'Agra', countryCode: 'IN' },
  { city: 'Nashik', countryCode: 'IN' },
  { city: 'Faridabad', countryCode: 'IN' },
  { city: 'Meerut', countryCode: 'IN' },
  { city: 'Rajkot', countryCode: 'IN' },
  { city: 'Varanasi', countryCode: 'IN' },
  { city: 'Srinagar', countryCode: 'IN' },
  { city: 'Aurangabad', countryCode: 'IN' },
  { city: 'Dhanbad', countryCode: 'IN' },
  { city: 'Amritsar', countryCode: 'IN' },
  { city: 'Navi Mumbai', countryCode: 'IN' },
  { city: 'Prayagraj', countryCode: 'IN' },
  { city: 'Ranchi', countryCode: 'IN' },
  { city: 'Howrah', countryCode: 'IN' },
  { city: 'Coimbatore', countryCode: 'IN' },
  { city: 'Jabalpur', countryCode: 'IN' },
  { city: 'Gwalior', countryCode: 'IN' },
  { city: 'Vijayawada', countryCode: 'IN' },
  { city: 'Jodhpur', countryCode: 'IN' },
  { city: 'Madurai', countryCode: 'IN' },
  { city: 'Raipur', countryCode: 'IN' },
  { city: 'Kota', countryCode: 'IN' },
  { city: 'Chandigarh', countryCode: 'IN' },
  { city: 'Guwahati', countryCode: 'IN' },
  { city: 'Solapur', countryCode: 'IN' },
  { city: 'Hubli', countryCode: 'IN' },
  { city: 'Mysuru', countryCode: 'IN' },
  { city: 'Tiruchirappalli', countryCode: 'IN' },
  { city: 'Gurugram', countryCode: 'IN' },
  { city: 'Noida', countryCode: 'IN' },
  { city: 'Kochi', countryCode: 'IN' },
  { city: 'Dehradun', countryCode: 'IN' },
  { city: 'Shimla', countryCode: 'IN' },
  { city: 'Panaji', countryCode: 'IN' },
  { city: 'Bhubaneswar', countryCode: 'IN' },
  { city: 'Thiruvananthapuram', countryCode: 'IN' },

  // United States
  { city: 'New York', countryCode: 'US' },
  { city: 'Los Angeles', countryCode: 'US' },
  { city: 'Chicago', countryCode: 'US' },
  { city: 'Houston', countryCode: 'US' },
  { city: 'Phoenix', countryCode: 'US' },
  { city: 'Philadelphia', countryCode: 'US' },
  { city: 'San Antonio', countryCode: 'US' },
  { city: 'San Diego', countryCode: 'US' },
  { city: 'Dallas', countryCode: 'US' },
  { city: 'Austin', countryCode: 'US' },
  { city: 'Seattle', countryCode: 'US' },
  { city: 'San Francisco', countryCode: 'US' },
  { city: 'Boston', countryCode: 'US' },
  { city: 'Washington', countryCode: 'US' },
  { city: 'Miami', countryCode: 'US' },
  { city: 'Atlanta', countryCode: 'US' },

  // United Kingdom
  { city: 'London', countryCode: 'GB' },
  { city: 'Birmingham', countryCode: 'GB' },
  { city: 'Manchester', countryCode: 'GB' },
  { city: 'Glasgow', countryCode: 'GB' },
  { city: 'Leeds', countryCode: 'GB' },
  { city: 'Liverpool', countryCode: 'GB' },
  { city: 'Edinburgh', countryCode: 'GB' },
  { city: 'Bristol', countryCode: 'GB' },
  { city: 'Belfast', countryCode: 'GB' },
  { city: 'Cardiff', countryCode: 'GB' },

  // Canada
  { city: 'Toronto', countryCode: 'CA' },
  { city: 'Montreal', countryCode: 'CA' },
  { city: 'Vancouver', countryCode: 'CA' },
  { city: 'Calgary', countryCode: 'CA' },
  { city: 'Ottawa', countryCode: 'CA' },
  { city: 'Edmonton', countryCode: 'CA' },

  // Australia
  { city: 'Sydney', countryCode: 'AU' },
  { city: 'Melbourne', countryCode: 'AU' },
  { city: 'Brisbane', countryCode: 'AU' },
  { city: 'Perth', countryCode: 'AU' },
  { city: 'Adelaide', countryCode: 'AU' },
  { city: 'Canberra', countryCode: 'AU' },

  // Germany
  { city: 'Berlin', countryCode: 'DE' },
  { city: 'Hamburg', countryCode: 'DE' },
  { city: 'Munich', countryCode: 'DE' },
  { city: 'Cologne', countryCode: 'DE' },
  { city: 'Frankfurt', countryCode: 'DE' },

  // France
  { city: 'Paris', countryCode: 'FR' },
  { city: 'Marseille', countryCode: 'FR' },
  { city: 'Lyon', countryCode: 'FR' },
  { city: 'Toulouse', countryCode: 'FR' },
  { city: 'Nice', countryCode: 'FR' },

  // Japan
  { city: 'Tokyo', countryCode: 'JP' },
  { city: 'Yokohama', countryCode: 'JP' },
  { city: 'Osaka', countryCode: 'JP' },
  { city: 'Kyoto', countryCode: 'JP' },
  { city: 'Nagoya', countryCode: 'JP' },

  // Brazil
  { city: 'Sao Paulo', countryCode: 'BR' },
  { city: 'Rio de Janeiro', countryCode: 'BR' },
  { city: 'Brasilia', countryCode: 'BR' },
  { city: 'Salvador', countryCode: 'BR' },

  // China
  { city: 'Beijing', countryCode: 'CN' },
  { city: 'Shanghai', countryCode: 'CN' },
  { city: 'Guangzhou', countryCode: 'CN' },
  { city: 'Shenzhen', countryCode: 'CN' }
];

export async function populateSeedLocations(options?: {
  cacheService?: LocationCacheService;
  countryFilter?: string;
  limit?: number;
  throttleMs?: number;
}): Promise<{ total: number; cached: number; failed: number }> {
  const cache = options?.cacheService ?? defaultCacheService;
  const throttleMs = options?.throttleMs ?? 150;

  let candidates = SEED_LOCATIONS;
  if (options?.countryFilter) {
    const targetCountry = options.countryFilter.toUpperCase();
    candidates = candidates.filter((c) => c.countryCode === targetCountry);
  }

  if (options?.limit && options.limit > 0) {
    candidates = candidates.slice(0, options.limit);
  }

  logger.info({ totalToSeed: candidates.length, countryFilter: options?.countryFilter }, 'Starting seed population');

  let cachedCount = 0;
  let failedCount = 0;

  for (const item of candidates) {
    try {
      const result = await cache.lookup(item.city, item.countryCode);
      if (result.record) {
        cachedCount++;
      } else {
        failedCount++;
      }
    } catch (err: any) {
      failedCount++;
      logger.warn({ city: item.city, country: item.countryCode, error: err.message }, 'Failed seeding location');
    }

    if (throttleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, throttleMs));
    }
  }

  logger.info({ total: candidates.length, cached: cachedCount, failed: failedCount }, 'Seed population finished');
  return { total: candidates.length, cached: cachedCount, failed: failedCount };
}
