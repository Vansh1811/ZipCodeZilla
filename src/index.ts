import fs from 'node:fs';
import { config } from './config/index.js';
import { createLogger } from './logger/index.js';
import { defaultCacheService } from './cache/index.js';
import { populateSeedLocations } from './seed/index.js';
import { LocationScheduler } from './scheduler/index.js';
import { LocationPipeline } from './pipeline/index.js';
import { StateManager } from './state/index.js';
import { LocationExporter } from './exporter/index.js';
import type { RunMode } from './types.js';

const logger = createLogger({ module: 'cli' });

function printHelp(): void {
  console.log(`
========================================================================
LOCATION DATA INGESTION & CACHING PIPELINE (Google Maps Platform API)
========================================================================

USAGE:
  tsx src/index.ts <command> [options]

COMMANDS:
  lookup <city>          Perform a cache-first location lookup
    --country <code>     ISO 3166-1 alpha-2 country code (e.g. IN, US, GB)

  seed                   Populate initial cache with major cities via API
    --country <code>     Limit seeding to a specific country (e.g. IN)
    --limit <num>        Limit total cities to seed (default: all)

  refresh                Trigger an on-demand refresh for cached records (Administrative)
    --force              Force re-fetching of all records regardless of TTL

  prune                  Prune expired records exceeding 30-day TTL (Google ToS compliance)

  schedule               Run the background cron scheduler daemon for maintenance (UTC)

  status                 Display cache statistics, counts, and manifest status

  import                 GeoNames bulk offline import pipeline (CC-BY 4.0 open data)
    --mode <mode>        'full' | 'incremental' | 'country'
    --country <code>     Country ISO code

  help                   Show this help message

EXAMPLES:
  # Lookup Mumbai (Cache Miss -> Calls API -> Caches to JSON)
  tsx src/index.ts lookup "Mumbai" --country IN

  # Repeat lookup for Mumbai (Cache HIT -> 0 API calls)
  tsx src/index.ts lookup "Mumbai" --country IN

  # Pre-seed top 10 cities for India
  tsx src/index.ts seed --country IN --limit 10

  # Check cache statistics
  tsx src/index.ts status
========================================================================
`);
}

async function handleLookup(args: string[]): Promise<void> {
  const cityName = args[0];
  if (!cityName || cityName.startsWith('-')) {
    console.error('Error: City name is required. Usage: tsx src/index.ts lookup "City Name" [--country CC]');
    process.exit(1);
  }

  let countryCode: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--country' && args[i + 1]) {
      countryCode = args[i + 1].toUpperCase();
      i++;
    }
  }

  console.log(`\nLooking up location: "${cityName}" (Country: ${countryCode || 'Any'})...`);
  const result = await defaultCacheService.lookup(cityName, countryCode);

  console.log('\n--- Lookup Result ---');
  console.log(`Status:      ${result.status}`);
  console.log(`From Cache:  ${result.fromCache ? 'YES (0 external API calls)' : 'NO (fetched from Google Maps API)'}`);
  console.log(`Refreshed:   ${result.refreshed ? 'YES' : 'NO'}`);
  console.log(`Cache Key:   ${result.cacheKey}`);

  if (result.record) {
    console.log(`\nLocation Details:`);
    console.log(`  ID:          ${result.record.id}`);
    console.log(`  Name:        ${result.record.name} (${result.record.asciiName})`);
    console.log(`  Country:     ${result.record.countryName} (${result.record.countryCode})`);
    console.log(`  Admin 1:     ${result.record.admin1Name || 'N/A'} (${result.record.admin1Code || 'N/A'})`);
    console.log(`  Coordinates: ${result.record.latitude}, ${result.record.longitude}`);
    console.log(`  Timezone:    ${result.record.timezone || 'N/A'}`);
    console.log(`  Source:      ${result.record.source}`);
    console.log(`  Updated At:  ${result.record.updatedAt}`);
  } else if (result.error) {
    console.error(`\nError: ${result.error}`);
  } else {
    console.log('\nNo matching location found.');
  }
}

async function handleSeed(args: string[]): Promise<void> {
  let countryFilter: string | undefined;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--country' && args[i + 1]) {
      countryFilter = args[i + 1].toUpperCase();
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }

  console.log(`Starting cache seeding (Country: ${countryFilter || 'ALL'}, Limit: ${limit || 'ALL'})...`);
  const res = await populateSeedLocations({
    countryFilter,
    limit,
    throttleMs: 150
  });

  console.log(`\nSeeding completed: ${res.cached} cached / ${res.total} candidates (${res.failed} failed).`);
}

async function handleRefresh(args: string[]): Promise<void> {
  const forceAll = args.includes('--force');
  console.log(`Starting cache refresh (Force all: ${forceAll ? 'YES' : 'NO'})...`);
  const res = await defaultCacheService.refreshStaleRecords({ forceAll });
  console.log(`\nRefresh completed: ${res.refreshed} refreshed, ${res.skipped} skipped, ${res.failed} failed of ${res.checked} checked.`);
}

async function handlePrune(): Promise<void> {
  console.log('Starting cache maintenance: pruning expired records (>30 days TTL, Google ToS compliance)...');
  const res = await defaultCacheService.pruneExpiredRecords();
  console.log(`\nPrune maintenance completed: ${res.pruned} pruned, ${res.retained} retained of ${res.checked} checked (0 external API calls).`);
}

async function handleSchedule(): Promise<void> {
  console.log(`Starting scheduler daemon. Schedule: "${config.cronSchedule}" (UTC), Cache TTL: ${config.cacheTtlDays} days`);
  const scheduler = new LocationScheduler();
  const started = scheduler.start();

  if (!started) {
    console.error('Failed to start scheduler.');
    process.exit(1);
  }

  const handleExit = () => {
    console.log('\nStopping scheduler...');
    scheduler.stop();
    process.exit(0);
  };

  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}

async function handleStatus(): Promise<void> {
  const exporter = new LocationExporter(config.dataDir);
  await defaultCacheService.initCache();
  const cacheStats = defaultCacheService.getStats();

  console.log('\n================ Location Cache Status ================');
  console.log(`Total Cached Records: ${cacheStats.totalCached}`);
  console.log(`Cache Hits:           ${cacheStats.hits}`);
  console.log(`Cache Misses:         ${cacheStats.misses}`);
  console.log(`Expired Refreshed:    ${cacheStats.refreshes}`);
  console.log(`Lookup Failures:      ${cacheStats.failures}`);

  const manifestPath = exporter.getManifestFilePath();
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      console.log(`Manifest Source:      ${manifest.source}`);
      console.log(`Manifest Generated:   ${manifest.generatedAt}`);
      console.log(`Covered Countries:    ${manifest.countryCoverage.map((c: any) => `${c.code} (${c.recordCount})`).join(', ')}`);
    } catch {
      // Ignore read error
    }
  }
  console.log('=======================================================\n');
}

async function handleLegacyImport(args: string[]): Promise<void> {
  let mode: RunMode = 'full';
  let targetCountry: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1] as RunMode;
      i++;
    } else if (args[i] === '--country' && args[i + 1]) {
      targetCountry = args[i + 1].toUpperCase();
      i++;
    }
  }

  const pipeline = new LocationPipeline();
  await pipeline.run({ mode, targetCountry });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'lookup':
      await handleLookup(args.slice(1));
      break;
    case 'seed':
      await handleSeed(args.slice(1));
      break;
    case 'refresh':
      await handleRefresh(args.slice(1));
      break;
    case 'prune':
      await handlePrune();
      break;
    case 'schedule':
      await handleSchedule();
      break;
    case 'status':
      await handleStatus();
      break;
    case 'import':
      await handleLegacyImport(args.slice(1));
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: "${command}"`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled CLI error');
  process.exit(1);
});
