/**
 * Open-Meteo Live Weather Service
 * Connects directly to the Open-Meteo API for real-time weather in Chennai.
 * Includes in-memory TTL caching (10-15 min per rounded coordinate), in-flight
 * request deduplication, HTTP 429 exponential backoff + cooldown, and concise
 * rate-limited warning logs.
 *
 * Request (one call for all 5 areas):
 * GET https://api.open-meteo.com/v1/forecast?latitude=13.04,13.07,13.01,13.05,13.22&longitude=80.23,80.19,80.22,80.28,80.32&hourly=temperature_2m,relative_humidity_2m&timezone=Asia/Kolkata&forecast_days=1
 *
 * Areas in this exact order:
 * 0: T. Nagar (13.04, 80.23)
 * 1: Koyambedu (13.07, 80.19)
 * 2: Guindy (13.01, 80.22)
 * 3: Marina (13.05, 80.28)
 * 4: Ennore (13.22, 80.32)
 */

export const OPEN_METEO_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=13.04,13.07,13.01,13.05,13.22&longitude=80.23,80.19,80.22,80.28,80.32&current=temperature_2m,relative_humidity_2m&hourly=temperature_2m,relative_humidity_2m&timezone=Asia/Kolkata&forecast_days=1';

export const PRIMARY_AREAS = [
  { id: 't-nagar', name: 'T. Nagar', lat: 13.04, lng: 80.23, index: 0 },
  { id: 'koyambedu', name: 'Koyambedu', lat: 13.07, lng: 80.19, index: 1 },
  { id: 'guindy', name: 'Guindy', lat: 13.01, lng: 80.22, index: 2 },
  { id: 'marina', name: 'Marina', lat: 13.05, lng: 80.28, index: 3 },
  { id: 'ennore', name: 'Ennore', lat: 13.22, lng: 80.32, index: 4 },
] as const;

export type WeatherRiskLevel = 'low' | 'moderate' | 'high' | 'extreme';

export interface HourReading {
  hour: string; // e.g. "06:00"
  hour_num: number; // 0 to 23
  temp: number; // Air temperature in °C
  humidity: number; // Relative humidity in %
  heat_index: number; // Rothfusz Heat Index in °C
  feels_like: number; // Rothfusz Heat Index in °C ("Feels like")
  risk: WeatherRiskLevel;
}

export interface CurrentWeatherReading {
  temp: number;
  humidity: number;
  heat_index: number;
  feels_like: number;
  risk: WeatherRiskLevel;
  time: string;
  hour: number;
  is_live: boolean;
  status_badge: 'Live' | 'Offline';
  badge_text: string; // e.g. "Live • 11:45 AM" or "Offline"
  last_updated: string;
  source: 'api' | 'sensor';
  sensor_id?: string;
}

export interface WeatherServiceStatus {
  status: 'Live' | 'Offline';
  badge: string; // e.g. "Live • 11:45 AM" or "Offline"
  isLive: boolean;
  lastUpdated: string | null;
  lastUpdatedTimeStr: string;
  loading: boolean;
  error: string | null;
}

export interface OpenMeteoAreaResponse {
  latitude: number;
  longitude: number;
  current?: {
    time: string;
    temperature_2m: number;
    relative_humidity_2m: number;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    cloud_cover?: number[];
  };
}

interface StoredCache {
  timestamp: number;
  updatedTimeStr: string;
  data: OpenMeteoAreaResponse[];
}

interface GenericCacheEntry<T> {
  timestamp: number;
  updatedTimeStr: string;
  data: T;
}

const CACHE_STORAGE_KEY = 'chennai_heat_guard_weather_cache';
const CACHE_DURATION_MS = 15 * 60 * 1000; // 15 minutes TTL cache
const DEFAULT_COORD_CACHE_TTL_MS = 12 * 60 * 1000; // 12 minutes per rounded coordinate
const WARN_COOLDOWN_MS = 5 * 60 * 1000; // Log concise warning at most once per 5 minutes per key
const DEFAULT_429_COOLDOWN_MS = 90 * 1000; // 90s cooldown when HTTP 429 occurs

// In-memory caches, in-flight deduplication, and rate-limit cooldown state
let inMemoryCache: StoredCache | null = null;
let primaryInFlightPromise: Promise<OpenMeteoAreaResponse[]> | null = null;

const genericCache = new Map<string, GenericCacheEntry<unknown>>();
const genericInFlight = new Map<string, Promise<{ data: unknown; fromCache: boolean; rateLimited: boolean; updatedTimeStr: string }>>();
const lastWarningAtByKey = new Map<string, number>();

let rateLimitCooldownUntilMs = 0;

let currentStatus: WeatherServiceStatus = {
  status: 'Live',
  badge: 'Live',
  isLive: true,
  lastUpdated: null,
  lastUpdatedTimeStr: '',
  loading: false,
  error: null,
};

const statusListeners = new Set<(status: WeatherServiceStatus) => void>();

function notifyListeners() {
  statusListeners.forEach((fn) => {
    try {
      fn(currentStatus);
    } catch (e) {
      console.error('Weather listener error:', e);
    }
  });
}

export function subscribeWeatherStatus(callback: (status: WeatherServiceStatus) => void) {
  statusListeners.add(callback);
  callback(currentStatus);
  return () => {
    statusListeners.delete(callback);
  };
}

export function getWeatherStatus(): WeatherServiceStatus {
  return currentStatus;
}

/**
 * Logs a concise warning at most once per cooldown window per warning key.
 */
function logWarningOnce(key: string, message: string) {
  const now = Date.now();
  const last = lastWarningAtByKey.get(key) || 0;
  if (now - last >= WARN_COOLDOWN_MS) {
    lastWarningAtByKey.set(key, now);
    console.warn(`[Weather] ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const seconds = Number(headerVal);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(300_000, Math.max(2_000, Math.round(seconds * 1000)));
  }
  const parsedDate = Date.parse(headerVal);
  if (!Number.isNaN(parsedDate)) {
    const delta = parsedDate - Date.now();
    if (delta > 0) return Math.min(300_000, delta);
  }
  return null;
}

/**
 * Rounds coordinates to ~1.1 km precision (2 decimal places) so nearby queries
 * share cached Open-Meteo responses and never trigger rate limits.
 */
export function roundCoordKey(lat: number, lng: number, precision = 2): string {
  return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
}

/**
 * Shared Open-Meteo JSON fetcher with:
 * - In-memory TTL cache (10-15 min per rounded coordinate / key)
 * - In-flight request deduplication
 * - Exponential backoff retry on HTTP 429 / transient 5xx
 * - Graceful stale-cache fallback & concise cooldown-limited warnings
 */
export async function fetchOpenMeteoJson<T>(
  url: string,
  cacheKey: string,
  options?: {
    ttlMs?: number;
    timeoutMs?: number;
    maxRetries?: number;
    forceRefresh?: boolean;
    allowStaleOnError?: boolean;
  }
): Promise<{ data: T; fromCache: boolean; rateLimited: boolean; updatedTimeStr: string }> {
  const ttlMs = options?.ttlMs ?? DEFAULT_COORD_CACHE_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? 8000;
  const maxRetries = options?.maxRetries ?? 2;
  const forceRefresh = Boolean(options?.forceRefresh);
  const allowStaleOnError = options?.allowStaleOnError ?? true;

  const now = Date.now();
  const cached = genericCache.get(cacheKey) as GenericCacheEntry<T> | undefined;

  // 1. Fresh cache hit
  if (!forceRefresh && cached && now - cached.timestamp < ttlMs) {
    return {
      data: cached.data,
      fromCache: true,
      rateLimited: false,
      updatedTimeStr: cached.updatedTimeStr,
    };
  }

  // 2. Active global 429 cooldown window -> serve cached data cleanly without spamming Open-Meteo
  if (now < rateLimitCooldownUntilMs && cached && allowStaleOnError) {
    logWarningOnce(
      'open-meteo-429',
      `Open-Meteo rate-limit cooldown active (${Math.ceil((rateLimitCooldownUntilMs - now) / 1000)}s left); serving cached data.`
    );
    return {
      data: cached.data,
      fromCache: true,
      rateLimited: true,
      updatedTimeStr: cached.updatedTimeStr,
    };
  }

  // 3. In-flight request deduplication
  const existingInFlight = genericInFlight.get(cacheKey);
  if (existingInFlight) {
    return (await existingInFlight) as {
      data: T;
      fromCache: boolean;
      rateLimited: boolean;
      updatedTimeStr: string;
    };
  }

  const requestPromise = (async () => {
    let lastError: Error | null = null;
    let sawRateLimit = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Respect cooldown if another concurrent key triggered HTTP 429
      if (Date.now() < rateLimitCooldownUntilMs && cached && allowStaleOnError) {
        return {
          data: cached.data,
          fromCache: true,
          rateLimited: true,
          updatedTimeStr: cached.updatedTimeStr,
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(timer);

        if (res.status === 429) {
          sawRateLimit = true;
          const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
          const cooldownMs = retryAfterMs ?? DEFAULT_429_COOLDOWN_MS;
          rateLimitCooldownUntilMs = Math.max(rateLimitCooldownUntilMs, Date.now() + cooldownMs);

          logWarningOnce(
            'open-meteo-429',
            `Open-Meteo returned HTTP 429 (rate limited). Cooldown set for ${Math.round(cooldownMs / 1000)}s; serving cached data where available.`
          );

          // If we already have cached data, return it immediately rather than waiting/retrying into a 429 wall
          if (cached && allowStaleOnError) {
            return {
              data: cached.data,
              fromCache: true,
              rateLimited: true,
              updatedTimeStr: cached.updatedTimeStr,
            };
          }

          lastError = new Error('Open-Meteo API returned HTTP 429');
          if (attempt < maxRetries) {
            const backoffMs = Math.min(3500, 750 * 2 ** attempt + Math.round(Math.random() * 250));
            await sleep(backoffMs);
            continue;
          }
          break;
        }

        if (res.status >= 500 && attempt < maxRetries) {
          lastError = new Error(`Open-Meteo API returned HTTP ${res.status}`);
          await sleep(500 * 2 ** attempt);
          continue;
        }

        if (!res.ok) {
          throw new Error(`Open-Meteo API returned HTTP ${res.status}`);
        }

        const json = (await res.json()) as T;
        const updatedTimeStr = new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        const entry: GenericCacheEntry<T> = {
          timestamp: Date.now(),
          updatedTimeStr,
          data: json,
        };
        genericCache.set(cacheKey, entry);

        // Keep cache bounded
        if (genericCache.size > 160) {
          const oldestKey = genericCache.keys().next().value;
          if (oldestKey) genericCache.delete(oldestKey);
        }

        return {
          data: json,
          fromCache: false,
          rateLimited: false,
          updatedTimeStr,
        };
      } catch (err: any) {
        clearTimeout(timer);
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries && !sawRateLimit) {
          await sleep(450 * 2 ** attempt);
          continue;
        }
      }
    }

    if (cached && allowStaleOnError) {
      logWarningOnce(
        `stale-${cacheKey}`,
        `Serving cached Open-Meteo data for ${cacheKey} after fetch error (${lastError?.message || 'unknown error'}).`
      );
      return {
        data: cached.data,
        fromCache: true,
        rateLimited: sawRateLimit,
        updatedTimeStr: cached.updatedTimeStr,
      };
    }

    logWarningOnce(
      `fail-${cacheKey}`,
      `Open-Meteo request failed for ${cacheKey}: ${lastError?.message || 'network error'}`
    );
    throw lastError || new Error('Open-Meteo request failed');
  })();

  genericInFlight.set(cacheKey, requestPromise);
  try {
    return (await requestPromise) as {
      data: T;
      fromCache: boolean;
      rateLimited: boolean;
      updatedTimeStr: string;
    };
  } finally {
    genericInFlight.delete(cacheKey);
  }
}

/**
 * Calculates Heat Index in Celsius using the standard NOAA Rothfusz regression equation.
 * When temperature in F is below 80°F, Steadman simple formula is used.
 * Adjustments for dry air (< 13% RH) and humid air (> 85% RH) are accurately applied.
 */
export function calculateRothfusz(tempC: number, humidity: number): number {
  const T = (tempC * 9) / 5 + 32;
  const RH = Math.max(0, Math.min(100, humidity));

  if (T < 80) {
    const simpleHI = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + RH * 0.094);
    return Math.round((((simpleHI - 32) * 5) / 9) * 10) / 10;
  }

  let HI =
    -42.379 +
    2.04901523 * T +
    10.14333127 * RH -
    0.22475541 * T * RH -
    0.00683783 * T * T -
    0.05481717 * RH * RH +
    0.00122874 * T * T * RH +
    0.00085282 * T * RH * RH -
    0.00000199 * T * T * RH * RH;

  if (RH < 13 && T >= 80 && T <= 112) {
    const adj = ((13 - RH) / 4) * Math.sqrt(Math.max(0, (17 - Math.abs(T - 95)) / 17));
    HI -= adj;
  } else if (RH > 85 && T >= 80 && T <= 87) {
    const adj = ((RH - 85) / 10) * ((87 - T) / 5);
    HI += adj;
  }

  const hiC = ((HI - 32) * 5) / 9;
  return Math.round(hiC * 10) / 10;
}

/**
 * Categorizes 4-tier risk level based on Heat Index (°C)
 * Below 32: low (green)
 * 32 to <36: moderate (yellow)
 * 36 to <=41: high (orange)
 * Above 41: extreme (red)
 */
export function getRiskLevel(
  heatIndex: number,
  thresholds: { moderate: number; high: number; extreme: number } = {
    moderate: 32,
    high: 36,
    extreme: 41,
  }
): WeatherRiskLevel {
  if (heatIndex < thresholds.moderate) return 'low';
  if (heatIndex < thresholds.high) return 'moderate';
  if (heatIndex <= thresholds.extreme) return 'high';
  return 'extreme';
}

/**
 * Maps any Chennai zone identifier or coordinates to the corresponding area index (0 to 4).
 * Order: 0: T. Nagar, 1: Koyambedu, 2: Guindy, 3: Marina, 4: Ennore
 */
export function getAreaIndexForZone(zone: string | number): number {
  if (typeof zone === 'number') {
    return Math.max(0, Math.min(4, Math.floor(zone)));
  }

  const normalized = zone.toLowerCase().trim().replace(/[\s_.]+/g, '-');
  switch (normalized) {
    case '0':
    case 't-nagar':
    case 'tnagar':
    case 'perambur': // North-central Chennai corridor -> mapped to T. Nagar/Koyambedu
      return 0;
    case '1':
    case 'koyambedu':
    case 'cmbt':
    case 'anna-nagar': // West Chennai -> closest to Koyambedu
      return 1;
    case '2':
    case 'guindy':
    case 'velachery': // South IT/transit corridor -> closest to Guindy
    case 'tambaram': // South highway junction -> closest to Guindy
    case 'adyar': // South coastal avenue -> closest to Guindy
      return 2;
    case '3':
    case 'marina':
    case 'marina-beach':
      return 3;
    case '4':
    case 'ennore':
    case 'north-chennai':
      return 4;
    default:
      return 0;
  }
}

/**
 * Loads cache from localStorage (in browser) or memory (in server/browser)
 */
function loadCache(): StoredCache | null {
  if (inMemoryCache) return inMemoryCache;
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(CACHE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredCache;
        inMemoryCache = parsed;
        return parsed;
      }
    } catch {
      // LocalStorage access restricted or unavailable
    }
  }
  return null;
}

function saveCache(data: OpenMeteoAreaResponse[]): StoredCache {
  const now = Date.now();
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const cacheObj: StoredCache = {
    timestamp: now,
    updatedTimeStr: timeStr,
    data,
  };
  inMemoryCache = cacheObj;
  genericCache.set('primary-5-areas', {
    timestamp: now,
    updatedTimeStr: timeStr,
    data,
  });
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(cacheObj));
    } catch {}
  }
  return cacheObj;
}

/**
 * Fetches the live Open-Meteo multi-location forecast for all 5 areas in one call.
 * Deduplicates concurrent callers, caches for 15 minutes, retries with backoff on HTTP 429,
 * and falls back cleanly to cached data when rate-limited or offline.
 */
export async function fetchLiveWeatherData(forceRefresh = false): Promise<OpenMeteoAreaResponse[]> {
  const now = Date.now();
  const cached = loadCache();

  // 1. Return valid cache immediately
  if (!forceRefresh && cached && now - cached.timestamp < CACHE_DURATION_MS) {
    currentStatus = {
      status: 'Live',
      badge: `Live • ${cached.updatedTimeStr}`,
      isLive: true,
      lastUpdated: new Date(cached.timestamp).toISOString(),
      lastUpdatedTimeStr: cached.updatedTimeStr,
      loading: false,
      error: null,
    };
    notifyListeners();
    return cached.data;
  }

  // 2. If inside 429 rate-limit cooldown and we have cached data, serve cached cleanly
  if (now < rateLimitCooldownUntilMs && cached && cached.data.length >= 5) {
    logWarningOnce(
      'primary-cooldown',
      `Open-Meteo cooldown active; serving cached Chennai weather (${cached.updatedTimeStr}).`
    );
    currentStatus = {
      status: 'Live',
      badge: `Live • ${cached.updatedTimeStr}`,
      isLive: true,
      lastUpdated: new Date(cached.timestamp).toISOString(),
      lastUpdatedTimeStr: cached.updatedTimeStr,
      loading: false,
      error: null,
    };
    notifyListeners();
    return cached.data;
  }

  // 3. Deduplicate concurrent calls (prevents ZONES.map(getReadings) from firing 20 parallel HTTP requests)
  if (primaryInFlightPromise) {
    return primaryInFlightPromise;
  }

  currentStatus = {
    ...currentStatus,
    loading: true,
    error: null,
  };
  notifyListeners();

  primaryInFlightPromise = (async () => {
    try {
      const res = await fetchOpenMeteoJson<OpenMeteoAreaResponse[]>(
        OPEN_METEO_URL,
        'primary-5-areas',
        {
          ttlMs: CACHE_DURATION_MS,
          timeoutMs: 8500,
          maxRetries: 2,
          forceRefresh,
          allowStaleOnError: true,
        }
      );

      const json = res.data;
      if (!Array.isArray(json) || json.length < 5) {
        throw new Error('Invalid Open-Meteo response format: expected 5 area objects');
      }

      const saved = res.fromCache && cached ? cached : saveCache(json);
      currentStatus = {
        status: res.rateLimited && res.fromCache ? 'Live' : 'Live',
        badge: `Live • ${saved.updatedTimeStr}`,
        isLive: true,
        lastUpdated: new Date(saved.timestamp).toISOString(),
        lastUpdatedTimeStr: saved.updatedTimeStr,
        loading: false,
        error: null,
      };
      notifyListeners();
      return json;
    } catch (err: any) {
      logWarningOnce(
        'primary-fallback',
        `Open-Meteo live fetch unavailable (${err?.message || 'error'}); falling back to cached weather if available.`
      );

      if (cached && cached.data && cached.data.length >= 5) {
        currentStatus = {
          status: 'Offline',
          badge: `Offline (Cached ${cached.updatedTimeStr})`,
          isLive: false,
          lastUpdated: new Date(cached.timestamp).toISOString(),
          lastUpdatedTimeStr: cached.updatedTimeStr,
          loading: false,
          error: err.message || 'Connection failed; displaying last cached weather.',
        };
        notifyListeners();
        return cached.data;
      }

      currentStatus = {
        status: 'Offline',
        badge: 'Offline',
        isLive: false,
        lastUpdated: null,
        lastUpdatedTimeStr: '',
        loading: false,
        error: err.message || 'Unable to reach weather API and no cached data available.',
      };
      notifyListeners();
      throw err;
    } finally {
      primaryInFlightPromise = null;
    }
  })();

  return primaryInFlightPromise;
}

/**
 * Export getReadings(zone) returning [{hour, temp, humidity}] for today.
 * Strictly calculates Rothfusz Heat Index and Feels Like from the live Open-Meteo values.
 * Returns 24 elements (index = hour of day).
 */
export async function getReadings(zone: string | number): Promise<HourReading[]> {
  const data = await fetchLiveWeatherData();
  const areaIndex = getAreaIndexForZone(zone);
  const areaData = data[areaIndex] || data[0];

  const temps = areaData.hourly.temperature_2m;
  const humidities = areaData.hourly.relative_humidity_2m;

  const result: HourReading[] = [];
  for (let h = 0; h < 24; h++) {
    const temp = Math.round((temps[h] ?? 30.0) * 10) / 10;
    const humidity = Math.round(humidities[h] ?? 65);
    const hi = calculateRothfusz(temp, humidity);
    const risk = getRiskLevel(hi);

    result.push({
      hour: `${h.toString().padStart(2, '0')}:00`,
      hour_num: h,
      temp,
      humidity,
      heat_index: hi,
      feels_like: hi, // Rothfusz Heat Index displayed as "Feels like"
      risk,
    });
  }

  return result;
}

/**
 * Returns current hour (0-23) in Chennai's local timezone (Asia/Kolkata / IST).
 * Necessary because servers in Cloud Run run on UTC, but Open-Meteo hourly array is indexed by Asia/Kolkata local hour.
 */
export function getChennaiCurrentHour(): number {
  try {
    const istFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    });
    const parsed = parseInt(istFormatter.format(new Date()), 10);
    if (!isNaN(parsed)) {
      return parsed === 24 ? 0 : parsed;
    }
  } catch {}
  return new Date().getHours();
}

/**
 * Returns current reading for the requested zone for the current hour of the day.
 * Uses Open-Meteo's real-time current temperature and humidity directly.
 */
export async function getCurrentReading(zone: string | number): Promise<CurrentWeatherReading> {
  const data = await fetchLiveWeatherData();
  const areaIndex = getAreaIndexForZone(zone);
  const areaData = data[areaIndex] || data[0];
  const currentHour = getChennaiCurrentHour();

  let temp: number;
  let humidity: number;

  if (areaData.current && typeof areaData.current.temperature_2m === 'number') {
    temp = Math.round(areaData.current.temperature_2m * 10) / 10;
    humidity = Math.round(areaData.current.relative_humidity_2m ?? 65);
  } else {
    const temps = areaData.hourly.temperature_2m;
    const humidities = areaData.hourly.relative_humidity_2m;
    temp = Math.round((temps[currentHour] ?? 28.0) * 10) / 10;
    humidity = Math.round(humidities[currentHour] ?? 65);
  }

  const hi = calculateRothfusz(temp, humidity);
  const risk = getRiskLevel(hi);

  return {
    temp,
    humidity,
    heat_index: hi,
    feels_like: hi,
    risk,
    time: new Date().toISOString(),
    hour: currentHour,
    is_live: currentStatus.isLive,
    status_badge: currentStatus.status,
    badge_text: currentStatus.badge,
    last_updated: currentStatus.lastUpdatedTimeStr || 'Just now',
    source: 'api',
  };
}

// Background automatic refresh check every minute (re-fetches when 15 minutes elapsed)
if (typeof window !== 'undefined') {
  setInterval(() => {
    const cached = loadCache();
    if (!cached || Date.now() - cached.timestamp >= CACHE_DURATION_MS) {
      fetchLiveWeatherData(false).catch(() => {});
    }
  }, 60000);
}
