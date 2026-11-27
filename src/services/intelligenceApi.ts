import {
  CoolRouteResponse,
  ExtendedForecastResponse,
  ForecastHorizon,
  ShadePredictionResponse,
} from '../types';

export async function fetchShadePrediction(params: {
  lat: number;
  lng: number;
  radiusMeters?: number;
  departureTimeIso?: string;
  cloudCoverPct?: number | null;
  signal?: AbortSignal;
}): Promise<ShadePredictionResponse> {
  const search = new URLSearchParams({
    lat: String(params.lat),
    lng: String(params.lng),
    radius: String(params.radiusMeters ?? 450),
  });
  if (params.departureTimeIso) {
    search.set('departure', params.departureTimeIso);
  }
  if (params.cloudCoverPct !== undefined && params.cloudCoverPct !== null) {
    search.set('cloudCover', String(params.cloudCoverPct));
  }

  const res = await fetch(`/api/shade-estimate?${search.toString()}`, {
    signal: params.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error || `Shade prediction failed (${res.status})`);
  }
  return res.json();
}

export async function fetchCoolRoutes(params: {
  origin: { lat: number; lng: number; label: string };
  destination: { lat: number; lng: number; label: string };
  departureTimeIso?: string;
  signal?: AbortSignal;
}): Promise<CoolRouteResponse> {
  const res = await fetch('/api/cool-route', {
    method: 'POST',
    signal: params.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      origin: params.origin,
      destination: params.destination,
      departureTimeIso: params.departureTimeIso || new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error || `CoolRoute lookup failed (${res.status})`);
  }
  return res.json();
}

export async function fetchExtendedForecast(params: {
  lat: number;
  lng: number;
  label: string;
  horizonHours: ForecastHorizon;
  signal?: AbortSignal;
}): Promise<ExtendedForecastResponse> {
  const search = new URLSearchParams({
    lat: String(params.lat),
    lng: String(params.lng),
    label: params.label,
    horizon: String(params.horizonHours),
  });
  const res = await fetch(`/api/forecast-extended?${search.toString()}`, {
    signal: params.signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody?.error || `Extended forecast failed (${res.status})`);
  }
  return res.json();
}

export interface GeocodePlaceResult {
  id: string;
  label: string;
  sublabel: string;
  lat: number;
  lng: number;
  source: 'osm-nominatim';
}

export async function searchChennaiPlaces(
  query: string,
  signal?: AbortSignal
): Promise<GeocodePlaceResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const search = new URLSearchParams({ q: trimmed });
  const res = await fetch(`/api/geocode?${search.toString()}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: GeocodePlaceResult[] };
  return Array.isArray(data.results) ? data.results : [];
}

