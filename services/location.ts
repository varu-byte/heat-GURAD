import {
  PRIMARY_AREAS,
  HourReading,
  OpenMeteoAreaResponse,
  calculateRothfusz,
  getRiskLevel,
  getChennaiCurrentHour,
  fetchOpenMeteoJson,
  roundCoordKey,
} from './weather';

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface PointWeatherReading extends Coordinates {
  temp: number;
  humidity: number;
  heat_index: number;
  feels_like: number;
  risk: 'low' | 'moderate' | 'high' | 'extreme';
  time: string;
  hourly: HourReading[];
}

export interface LocationWeatherResult {
  reading: PointWeatherReading;
  status: 'Live' | 'Offline';
  isLive: boolean;
  updatedTimeStr: string;
  error: string | null;
}

export type LocationErrorCode = 'DENIED' | 'UNAVAILABLE' | 'TIMEOUT';

export class LocationError extends Error {
  code: LocationErrorCode;
  constructor(code: LocationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'LocationError';
  }
}

/**
 * Exact Haversine distance in kilometers (unrounded for accurate sorting).
 */
export function calculateDistanceKmExact(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * Finds the nearest of the 5 primary Chennai areas (T. Nagar, Koyambedu, Guindy, Marina, Ennore).
 */
export function findNearestArea(lat: number, lng: number) {
  let nearest: (typeof PRIMARY_AREAS)[number] = PRIMARY_AREAS[0];
  let minDistance = Infinity;

  for (const area of PRIMARY_AREAS) {
    const dist = calculateDistanceKmExact(lat, lng, area.lat, area.lng);
    if (dist < minDistance) {
      minDistance = dist;
      nearest = area;
    }
  }

  return {
    ...nearest,
    distanceKm: Math.round(minDistance * 10) / 10,
  };
}

/**
 * Requests the browser's GPS location ONLY when explicitly invoked by user tap.
 * Never persisted anywhere — session memory only.
 */
export function getUserLocation(): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(
        new LocationError(
          'UNAVAILABLE',
          'Location is not supported or unavailable in this browser.'
        )
      );
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: Math.round(pos.coords.latitude * 100000) / 100000,
          lng: Math.round(pos.coords.longitude * 100000) / 100000,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          reject(
            new LocationError(
              'DENIED',
              'Location permission was denied. Showing nearest Chennai area instead.'
            )
          );
        } else if (err.code === err.TIMEOUT) {
          reject(
            new LocationError(
              'TIMEOUT',
              'Location request timed out. Showing nearest Chennai area instead.'
            )
          );
        } else {
          reject(
            new LocationError(
              'UNAVAILABLE',
              'Unable to detect your location. Showing nearest Chennai area instead.'
            )
          );
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  });
}

// Transient in-memory session-only cache (never saved to localStorage/sessionStorage/server)
let sessionLastLocationWeather: LocationWeatherResult | null = null;

function parseOpenMeteoPoint(
  raw: OpenMeteoAreaResponse,
  coords: Coordinates
): PointWeatherReading {
  const currentHour = getChennaiCurrentHour();
  const temps = raw.hourly?.temperature_2m || [];
  const humidities = raw.hourly?.relative_humidity_2m || [];

  const hourly: HourReading[] = [];
  for (let h = 0; h < 24; h++) {
    const temp = Math.round((temps[h] ?? 28.0) * 10) / 10;
    const humidity = Math.round(humidities[h] ?? 65);
    const hi = calculateRothfusz(temp, humidity);
    hourly.push({
      hour: `${h.toString().padStart(2, '0')}:00`,
      hour_num: h,
      temp,
      humidity,
      heat_index: hi,
      feels_like: hi,
      risk: getRiskLevel(hi),
    });
  }

  let temp: number;
  let humidity: number;
  if (raw.current && typeof raw.current.temperature_2m === 'number') {
    temp = Math.round(raw.current.temperature_2m * 10) / 10;
    humidity = Math.round(raw.current.relative_humidity_2m ?? 65);
  } else {
    temp = Math.round((temps[currentHour] ?? 28.0) * 10) / 10;
    humidity = Math.round(humidities[currentHour] ?? 65);
  }

  const hi = calculateRothfusz(temp, humidity);

  return {
    lat: coords.lat,
    lng: coords.lng,
    temp,
    humidity,
    heat_index: hi,
    feels_like: hi,
    risk: getRiskLevel(hi),
    time: new Date().toISOString(),
    hourly,
  };
}

/**
 * Fetches live Open-Meteo weather and Rothfusz Heat Index for a single exact coordinate
 * in one HTTP GET request. Never persists coordinates outside the current browser session.
 */
export async function fetchLocationWeather(
  lat: number,
  lng: number
): Promise<LocationWeatherResult> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}&current=temperature_2m,relative_humidity_2m&hourly=temperature_2m,relative_humidity_2m&timezone=Asia/Kolkata&forecast_days=1`;
  const cacheKey = `loc:${roundCoordKey(lat, lng, 2)}`;

  try {
    const { data: json, updatedTimeStr, rateLimited } = await fetchOpenMeteoJson<OpenMeteoAreaResponse>(
      url,
      cacheKey,
      { ttlMs: 12 * 60 * 1000, timeoutMs: 9000, maxRetries: 2, allowStaleOnError: true }
    );
    const reading = parseOpenMeteoPoint(json, { lat, lng });

    const result: LocationWeatherResult = {
      reading,
      status: 'Live',
      isLive: true,
      updatedTimeStr,
      error: rateLimited ? 'Rate-limit active; serving cached weather for your area.' : null,
    };

    sessionLastLocationWeather = result;
    return result;
  } catch (err: any) {
    if (sessionLastLocationWeather) {
      return {
        ...sessionLastLocationWeather,
        status: 'Offline',
        isLive: false,
        error: err?.message || 'Connection failed; showing session cache.',
      };
    }

    throw new Error(err?.message || 'Unable to fetch weather for your location');
  }
}
