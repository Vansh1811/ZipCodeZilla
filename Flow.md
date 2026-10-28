User Query: ("Mumbai", "IN")
      │
      ▼
[Step 1: Input Normalization & Alias Translation]
  • Lowercases, trims, and strips diacritics.
  • Checks Alias Table: "Bombay" ➔ "Mumbai", "Bangalore" ➔ "Bengaluru", "Peking" ➔ "Beijing".
      │
      ▼
[Step 2: Request Coalescing (Singleflight)]
  • If 100 users search "Mumbai" at the exact same millisecond:
  • Only 1 worker executes the resolution; the other 99 wait and share the single result.
  • (Prevents server CPU spikes and Google API flooding).
      │
      ▼
[Step 3: Tier 1 — Local Offline Database Check (< 5ms, $0.00 Cost)]
  • Targets the country partition (e.g., India or any of the 245 countries).
  • Looks at the 2-character Prefix Index (e.g., mu.json).
  • Reads ONLY the matching bytes from disk via direct file descriptor read.
  • Ranks candidates: National Capital (PPLC) > Metro > Small Town > Population count.
  • ───► IF FOUND: Returns instantly. 0 API calls. Sub-5ms response time.
      │
      ▼ (If NOT found in open data)
[Step 4: Tier 2 — Local Google Cache Check ($0.00 Cost)]
  • Checks the local cache file: data/locations/countries/IN.cache.json.
  • If previously resolved and updated within the last 30 days:
  • ───► IF FRESH: Returns from cache. 0 API calls.
      │
      ▼ (If missing or older than 30 days)
[Step 5: Tier 3 — Google Maps Geocoding API Fallback (~200ms, Paid Call)]
  • Calls Google Geocoding & Timezone APIs with your API key.
  • Resolves coordinates, administrative level, place_id, and timezone.
  • Writes the new record to IN.cache.json with current timestamp.
  • (Never modifies or contaminates the open-data bulk files).
      │
      ▼
[Step 6: Background Maintenance — Automated 30-Day TTL Pruning]
  • Runs weekly on a UTC cron schedule.
  • Scans all *.cache.json files.
  • Evicts any Google record older than 30 days to strictly obey Google Maps Terms of Service.
  • Bulk GeoNames records are permanent and never deleted.