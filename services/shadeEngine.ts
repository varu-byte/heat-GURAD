import fs from 'fs';
import path from 'path';
import * as SunCalc from 'suncalc';

const sunCalcApi =
  (SunCalc as unknown as { default?: typeof SunCalc }).default || SunCalc;

import {
  EstimatedShadowPolygon,
  ReliefPoint,
  ShadePredictionResponse,
  ShadeReliabilityLevel,
  ShadeReliabilitySummary,
  ShadedRoadSegment,
  SunPositionInfo,
  TreeCanopyNode,
} from '../src/types';

interface OsmBuildingFeature {
  id: string;
  polygon: [number, number][];
  centroid: [number, number];
  heightMeters: number;
  heightSource: 'measured-height' | 'levels-estimated' | 'footprint-inferred';
}

interface OsmRoadFeature {
  id: string;
  coordinates: [number, number][];
}

interface OverpassAreaCache {
  fetchedAt: number;
  buildings: OsmBuildingFeature[];
  trees: TreeCanopyNode[];
  roads: OsmRoadFeature[];
  treesCount: number;
  parksCount: number;
  greenZonesCount: number;
  dataSource: 'osm-overpass' | 'partial-osm' | 'unavailable';
  fetchNote?: string;
}

// Primary + fallback Overpass mirrors raced concurrently so slow or rate-limited nodes fail over seamlessly
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

const OVERPASS_CACHE = new Map<string, OverpassAreaCache>();
const OVERPASS_IN_FLIGHT = new Map<string, Promise<OverpassAreaCache>>();
const CACHE_TTL_MS = 30 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 3 * 60 * 1000;
const OVERPASS_TIMEOUT_MS = 9000;

let lastOverpassWarnAt = 0;

function loadStaticReliefPoints(): ReliefPoint[] {
  try {
    const filePath = path.join(process.cwd(), 'data', 'relief-points.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ReliefPoint[];
  } catch {
    return [];
  }
}

/**
 * Returns solar altitude (degrees), compass azimuth (0=N, 90=E, 180=S, 270=W),
 * sunrise/sunset ISO strings, and a human-readable solar phase label via SunCalc.
 */
export function getSunPositionInfo(
  lat: number,
  lng: number,
  departureIso: string
): SunPositionInfo {
  const date = new Date(departureIso);
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const pos = sunCalcApi.getPosition(validDate, lat, lng);
  const times = sunCalcApi.getTimes(validDate, lat, lng);

  // SunCalc v2.1.4 returns altitude in degrees (-90..90) and north-based clockwise azimuth in degrees (0=N, 90=E, 180=S, 270=W)
  const altitudeDeg = Math.round(pos.altitude * 10) / 10;
  const azimuthCompassDeg = Math.round((((pos.azimuth % 360) + 360) % 360) * 10) / 10;
  const isDaylight = altitudeDeg > 2;

  let solarLabel = 'Night / Twilight (Minimal Direct Solar Load)';
  if (altitudeDeg > 60) {
    solarLabel = 'Overhead High Sun (Short Shadows)';
  } else if (altitudeDeg > 25) {
    solarLabel = 'Mid-Angle Sun (Moderate Building & Tree Shadows)';
  } else if (isDaylight) {
    solarLabel = 'Low-Angle Sun (Long Directional Shadows)';
  }

  return {
    timestampIso: validDate.toISOString(),
    altitudeDeg,
    azimuthCompassDeg,
    isDaylight,
    sunriseIso: times.sunrise ? times.sunrise.toISOString() : validDate.toISOString(),
    sunsetIso: times.sunset ? times.sunset.toISOString() : validDate.toISOString(),
    solarLabel,
  };
}

function metersOffsetToLatLng(
  lat: number,
  lng: number,
  eastMeters: number,
  northMeters: number
): [number, number] {
  const dLat = northMeters / 111320;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dLng = eastMeters / (111320 * cosLat);
  return [
    Math.round((lat + dLat) * 1e6) / 1e6,
    Math.round((lng + dLng) * 1e6) / 1e6,
  ];
}

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function computeSegmentBearingDeg(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/**
 * Parses explicit OSM height / building:levels tags, and when missing infers a realistic
 * urban Chennai baseline building height between 8.0m and 12.0m based on building type & footprint span.
 */
function parseOrInferBuildingHeight(
  tags: Record<string, string> | undefined,
  polygon: [number, number][]
): {
  heightMeters: number;
  source: 'measured-height' | 'levels-estimated' | 'footprint-inferred';
} {
  if (tags?.height) {
    const num = parseFloat(String(tags.height).replace(/[^\d.]/g, ''));
    if (!Number.isNaN(num) && num > 1 && num < 400) {
      return { heightMeters: Math.round(num * 10) / 10, source: 'measured-height' };
    }
  }

  if (tags?.['building:levels']) {
    const levels = parseFloat(String(tags['building:levels']));
    if (!Number.isNaN(levels) && levels >= 1 && levels <= 120) {
      return {
        heightMeters: Math.round(levels * 3.2 * 10) / 10,
        source: 'levels-estimated',
      };
    }
  }

  // Infer conservative baseline height (8m-12m) from OSM building class & footprint bounding span
  const bType = String(tags?.building || '').toLowerCase();
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [pLat, pLng] of polygon) {
    if (pLat < minLat) minLat = pLat;
    if (pLat > maxLat) maxLat = pLat;
    if (pLng < minLng) minLng = pLng;
    if (pLng > maxLng) maxLng = pLng;
  }
  const spanM = Math.max(
    haversineMeters(minLat, minLng, maxLat, minLng),
    haversineMeters(minLat, minLng, minLat, maxLng)
  );

  let inferred = 9.5;
  if (
    /commercial|office|apartments|retail|hospital|hotel|university|public|civic|school|industrial|mall/.test(
      bType
    )
  ) {
    inferred = spanM > 28 ? 12.0 : 11.0;
  } else if (/house|detached|bungalow|shed|hut|garages?/.test(bType)) {
    inferred = 8.0;
  } else if (/residential|terrace/.test(bType)) {
    inferred = 9.0;
  } else {
    // Generic building=yes inferred smoothly between 8.5m and 12.0m
    if (spanM >= 32) inferred = 12.0;
    else if (spanM >= 18) inferred = 10.5;
    else inferred = 8.5;
  }

  return { heightMeters: inferred, source: 'footprint-inferred' };
}

/**
 * Fetches building footprints, trees, parks, landuse=forest/meadow, and walkable roads from Overpass mirrors.
 * Deduplicates concurrent spatial queries and fails over smoothly across mirrors.
 */
async function fetchOsmUrbanGeometry(
  lat: number,
  lng: number,
  radiusMeters: number
): Promise<OverpassAreaCache> {
  const clampedRadius = Math.max(250, Math.min(900, Math.round(radiusMeters)));
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${Math.round(clampedRadius / 50) * 50}`;
  const cached = OVERPASS_CACHE.get(cacheKey);
  if (cached) {
    const ttl = cached.dataSource === 'unavailable' ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) {
      return cached;
    }
  }

  const inFlight = OVERPASS_IN_FLIGHT.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const query = `
[out:json][timeout:10];
(
  way["building"](around:${clampedRadius},${lat},${lng});
  node["natural"="tree"](around:${clampedRadius},${lat},${lng});
  way["natural"~"wood|tree_row"](around:${clampedRadius},${lat},${lng});
  way["leisure"~"park|garden"](around:${clampedRadius},${lat},${lng});
  way["landuse"~"forest|meadow|orchard|recreation_ground|village_green"](around:${clampedRadius},${lat},${lng});
  way["highway"~"footway|pedestrian|residential|secondary|tertiary|primary|path|living_street"](around:${clampedRadius},${lat},${lng});
);
out body geom qt;
`;

  const fetchPromise = (async (): Promise<OverpassAreaCache> => {
    let lastErr: string | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

    try {
      const fetchOneMirror = async (endpoint: string) => {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Accept: 'application/json',
            'User-Agent': 'ChennaiHeatGuard/1.1 (Heat Safety Mapping)',
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Overpass HTTP ${res.status}`);
        }
        return (await res.json()) as { elements?: any[] };
      };

      const json = await Promise.any(OVERPASS_ENDPOINTS.map((ep) => fetchOneMirror(ep)));
      clearTimeout(timer);
      controller.abort();

      const elements = Array.isArray(json.elements) ? json.elements : [];

      const buildings: OsmBuildingFeature[] = [];
      const trees: TreeCanopyNode[] = [];
      const roads: OsmRoadFeature[] = [];
      let treesCount = 0;
      let parksCount = 0;
      let greenZonesCount = 0;

      for (const el of elements) {
        if (
          el.type === 'node' &&
          el.tags?.natural === 'tree' &&
          typeof el.lat === 'number' &&
          typeof el.lon === 'number'
        ) {
          treesCount += 1;
          trees.push({
            id: `tree-${el.id}`,
            lat: el.lat,
            lng: el.lon,
            radiusMeters: 7,
            source: 'osm-tree',
          });
          continue;
        }

        if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) {
          continue;
        }

        const coords: [number, number][] = el.geometry
          .filter((g: any) => typeof g.lat === 'number' && typeof g.lon === 'number')
          .map((g: any) => [g.lat, g.lon]);

        if (coords.length < 2) continue;

        if (el.tags?.building && coords.length >= 3) {
          const parsedH = parseOrInferBuildingHeight(el.tags, coords);
          const avgLat = coords.reduce((acc, c) => acc + c[0], 0) / coords.length;
          const avgLng = coords.reduce((acc, c) => acc + c[1], 0) / coords.length;
          buildings.push({
            id: `bldg-${el.id}`,
            polygon: coords.slice(0, 14),
            centroid: [avgLat, avgLng],
            heightMeters: parsedH.heightMeters,
            heightSource: parsedH.source,
          });
        } else if (
          el.tags?.leisure === 'park' ||
          el.tags?.leisure === 'garden' ||
          el.tags?.natural === 'wood' ||
          el.tags?.natural === 'tree_row' ||
          /forest|meadow|orchard|recreation_ground|village_green/.test(
            String(el.tags?.landuse || '')
          )
        ) {
          const avgLat = coords.reduce((acc, c) => acc + c[0], 0) / coords.length;
          const avgLng = coords.reduce((acc, c) => acc + c[1], 0) / coords.length;
          const landuse = String(el.tags?.landuse || '');

          let source: TreeCanopyNode['source'] = 'osm-park';
          let radius = 38;
          if (landuse === 'forest' || el.tags?.natural === 'wood') {
            source = 'osm-forest';
            radius = 46;
            greenZonesCount += 1;
          } else if (/meadow|orchard|recreation_ground|village_green/.test(landuse)) {
            source = 'osm-meadow';
            radius = 34;
            greenZonesCount += 1;
          } else if (el.tags?.natural === 'tree_row') {
            source = 'osm-tree';
            radius = 16;
            treesCount += 1;
          } else {
            source = 'osm-park';
            radius = 38;
            parksCount += 1;
          }

          trees.push({
            id: `green-${el.id}`,
            lat: avgLat,
            lng: avgLng,
            radiusMeters: radius,
            source,
          });
        } else if (el.tags?.highway) {
          roads.push({
            id: `road-${el.id}`,
            coordinates: coords,
          });
        }
      }

      const dataSource: OverpassAreaCache['dataSource'] =
        buildings.length === 0 && trees.length === 0 && roads.length === 0
          ? 'unavailable'
          : buildings.some(
                (b) => b.heightSource === 'measured-height' || b.heightSource === 'levels-estimated'
              ) && trees.length > 0
            ? 'osm-overpass'
            : 'partial-osm';

      const result: OverpassAreaCache = {
        fetchedAt: Date.now(),
        buildings: buildings.slice(0, 240),
        trees: trees.slice(0, 200),
        roads: roads.slice(0, 150),
        treesCount,
        parksCount,
        greenZonesCount,
        dataSource,
      };
      OVERPASS_CACHE.set(cacheKey, result);
      return result;
    } catch (err: any) {
      clearTimeout(timer);
      lastErr =
        err?.name === 'AbortError' || err?.errors?.some((e: any) => e?.name === 'AbortError')
          ? 'OpenStreetMap Overpass mirrors timed out; using solar geometry, corridor orientation, and verified relief shelters as fallback.'
          : err?.message || 'OpenStreetMap building & tree mirrors temporarily unavailable.';

      if (Date.now() - lastOverpassWarnAt > 5 * 60 * 1000) {
        lastOverpassWarnAt = Date.now();
        console.warn(`[ShadeEngine] ${lastErr}`);
      }
    }

    const unavailable: OverpassAreaCache = {
      fetchedAt: Date.now(),
      buildings: [],
      trees: [],
      roads: [],
      treesCount: 0,
      parksCount: 0,
      greenZonesCount: 0,
      dataSource: 'unavailable',
      fetchNote: lastErr || 'OpenStreetMap building & tree mirrors temporarily unavailable.',
    };
    OVERPASS_CACHE.set(cacheKey, unavailable);
    return unavailable;
  })();

  OVERPASS_IN_FLIGHT.set(cacheKey, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    OVERPASS_IN_FLIGHT.delete(cacheKey);
  }
}

/**
 * Computes shadow polygon cast by a building footprint given solar altitude & azimuth.
 * Supports explicit measured height, building:levels, and inferred 8m-12m baseline height.
 */
function projectBuildingShadowPolygon(
  building: OsmBuildingFeature,
  sun: SunPositionInfo
): EstimatedShadowPolygon | null {
  if (!sun.isDaylight) return null;

  const altRad = (Math.max(6, sun.altitudeDeg) * Math.PI) / 180;
  // Cap shadow projection length for local map readability
  const rawLength = building.heightMeters / Math.tan(altRad);
  const shadowLenMeters = Math.min(60, rawLength);

  // Opposite of sun azimuth
  const shadowDirRad = (((sun.azimuthCompassDeg + 180) % 360) * Math.PI) / 180;
  const eastShift = Math.sin(shadowDirRad) * shadowLenMeters;
  const northShift = Math.cos(shadowDirRad) * shadowLenMeters;

  const base = building.polygon;
  const shifted = base.map(([lat, lng]) =>
    metersOffsetToLatLng(lat, lng, eastShift, northShift)
  );

  const combined = [...base, ...shifted];
  const centerLat = combined.reduce((s, p) => s + p[0], 0) / combined.length;
  const centerLng = combined.reduce((s, p) => s + p[1], 0) / combined.length;

  const hull = [...combined].sort(
    (a, b) =>
      Math.atan2(a[0] - centerLat, a[1] - centerLng) -
      Math.atan2(b[0] - centerLat, b[1] - centerLng)
  );

  return {
    id: `shadow-${building.id}`,
    coordinates: hull,
    source: building.heightSource,
    heightMeters: building.heightMeters,
    isEstimated: true,
  };
}

/**
 * Point-in-polygon ray casting for [lat, lng] checks against projected shadows.
 */
function isPointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];

    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Scores any individual [lat, lng] point for estimated shade & thermal cover (0 = full sun, 1 = deep shade).
 * Incorporates:
 * 1. Verified shade/cooling/water relief proximity from data/relief-points.json
 * 2. Projected building shadows (measured height, building:levels, or inferred 8m-12m footprint)
 * 3. OSM tree, park, forest, meadow canopy overlap & proximity
 * 4. Solar-geometry cross-street orientation estimate when direct footprints are sparse/slow
 * 5. Forecast cloud cover attenuation
 */
export function scoreCoordinateShade(params: {
  lat: number;
  lng: number;
  sun: SunPositionInfo;
  shadows: EstimatedShadowPolygon[];
  trees: TreeCanopyNode[];
  staticShadePoints: ReliefPoint[];
  cloudCoverPct: number | null;
  segmentBearingDeg?: number | null;
}): { score: number; basis: string } {
  const {
    lat,
    lng,
    sun,
    shadows,
    trees,
    staticShadePoints,
    cloudCoverPct,
    segmentBearingDeg,
  } = params;

  // Compute nearest verified relief & canopy proximity even during twilight/night
  let nearestShadeDist = Infinity;
  let nearestShadeName = '';
  let nearestReliefDist = Infinity;
  let nearestReliefName = '';

  for (const rp of staticShadePoints) {
    const d = haversineMeters(lat, lng, rp.lat, rp.lng);
    if (rp.type === 'shade' && d < nearestShadeDist) {
      nearestShadeDist = d;
      nearestShadeName = rp.name;
    }
    if (d < nearestReliefDist) {
      nearestReliefDist = d;
      nearestReliefName = rp.name;
    }
  }

  let canopyCover = 0;
  let canopyLabel = '';
  for (const tree of trees) {
    const dist = haversineMeters(lat, lng, tree.lat, tree.lng);
    const effectiveR = tree.radiusMeters * 1.45;
    if (dist <= effectiveR) {
      const factor =
        tree.source === 'osm-forest'
          ? 0.78
          : tree.source === 'osm-tree'
            ? 0.72
            : tree.source === 'osm-park'
              ? 0.68
              : tree.source === 'relief-shade'
                ? 0.76
                : 0.56; // osm-meadow
      if (factor > canopyCover) {
        canopyCover = factor;
        canopyLabel =
          tree.source === 'osm-forest'
            ? 'Forest/woodland canopy'
            : tree.source === 'osm-meadow'
              ? 'Open green/meadow corridor'
              : tree.source === 'osm-park'
                ? 'Park greenery canopy'
                : tree.source === 'relief-shade'
                  ? 'Verified shade shelter buffer'
                  : 'Mapped OSM tree canopy';
      }
    } else if (dist <= effectiveR + 65) {
      // Soft proximity halo near parks/forests/tree rows
      const haloFactor = Math.max(0, 1 - (dist - effectiveR) / 65) * 0.32;
      if (haloFactor > canopyCover) {
        canopyCover = haloFactor;
        canopyLabel = 'Adjacent greenery/canopy buffer';
      }
    }
  }

  // Twilight / night handling: minimal direct sun, but still differentiate relief/canopy-rich corridors
  if (!sun.isDaylight) {
    let nightScore = 0.76;
    const reasons: string[] = ['Sun below horizon (minimal direct solar load)'];
    if (canopyCover > 0) {
      nightScore = Math.min(0.95, nightScore + canopyCover * 0.14);
      reasons.push(canopyLabel);
    }
    if (nearestReliefDist <= 280) {
      const bonus = (1 - nearestReliefDist / 280) * 0.12;
      nightScore = Math.min(0.96, nightScore + bonus);
      reasons.push(`Near verified relief (${nearestReliefName}, ${Math.round(nearestReliefDist)}m)`);
    }
    return {
      score: Math.round(nightScore * 100) / 100,
      basis: reasons.join(' · '),
    };
  }

  let score = 0;
  const reasons: string[] = [];

  // 1. Verified physical relief proximity (from data/relief-points.json)
  if (nearestShadeDist <= 55) {
    score = Math.max(score, 0.86);
    reasons.push(`Near verified shade shelter (${nearestShadeName})`);
  } else if (nearestShadeDist <= 260) {
    const prox = (1 - (nearestShadeDist - 55) / 205) * 0.42;
    if (prox > 0.08) {
      score = Math.max(score, prox);
      reasons.push(`Shade shelter corridor (${nearestShadeName}, ${Math.round(nearestShadeDist)}m)`);
    }
  } else if (nearestReliefDist <= 240) {
    const prox = (1 - nearestReliefDist / 240) * 0.28;
    if (prox > 0.08) {
      score = Math.max(score, prox);
      reasons.push(`Relief/water stop proximity (${nearestReliefName}, ${Math.round(nearestReliefDist)}m)`);
    }
  }

  // 2. Projected building shadow polygon intersection (measured, levels, or inferred 8-12m baseline)
  for (const sh of shadows) {
    if (isPointInPolygon([lat, lng], sh.coordinates)) {
      const bldgScore =
        sh.source === 'measured-height'
          ? 0.8
          : sh.source === 'levels-estimated'
            ? 0.76
            : 0.64; // footprint-inferred 8m-12m baseline (explicitly conservative)
      score = Math.max(score, bldgScore);
      reasons.push(
        sh.source === 'measured-height'
          ? 'Estimated building shadow (measured OSM height)'
          : sh.source === 'levels-estimated'
            ? 'Estimated building shadow (OSM building:levels)'
            : `Estimated building shadow (inferred ${sh.heightMeters}m baseline footprint)`
      );
      break;
    }
  }

  // 3. OSM Tree, park, forest, meadow canopy overlap or proximity
  if (canopyCover > 0) {
    score = Math.max(score, canopyCover);
    reasons.push(canopyLabel);
  }

  // 4. Directional urban street-canyon fallback estimate when street orientation is known
  // Streets perpendicular to solar azimuth cast side-building wall shadows when sun isn't directly overhead
  if (typeof segmentBearingDeg === 'number' && !Number.isNaN(segmentBearingDeg)) {
    const angleDiff = Math.abs(((segmentBearingDeg - sun.azimuthCompassDeg + 180) % 180 + 180) % 180);
    // sin(angleDiff) is 1.0 when street runs perpendicular to sun rays (best side-shadow potential), 0 when aligned with sun
    const crossSunFactor = Math.sin((angleDiff * Math.PI) / 180);
    const altitudeFactor = Math.max(0.15, Math.min(1, (78 - sun.altitudeDeg) / 55));
    const canyonEstimate = crossSunFactor * altitudeFactor * 0.34;
    if (canyonEstimate > 0.08) {
      if (score < 0.15) {
        score = Math.max(score, canyonEstimate);
        reasons.push(
          crossSunFactor > 0.65
            ? 'Cross-sun street orientation (estimated sidewalk shadow side)'
            : 'Partial oblique sun angle along street'
        );
      } else {
        // Modest additive lift for cross-sun corridors that also have canopy/relief
        score = Math.min(0.92, score + canyonEstimate * 0.25);
      }
    }
  }

  // 5. Weather cloud-cover solar attenuation (partial sky shade, does not replace physical cover)
  if (cloudCoverPct !== null && cloudCoverPct >= 35) {
    const cloudBonus = ((cloudCoverPct - 25) / 75) * 0.22;
    score = Math.min(0.94, score + cloudBonus);
    reasons.push(`Forecast cloud cover (~${Math.round(cloudCoverPct)}%)`);
  }

  if (reasons.length === 0) {
    reasons.push(
      sun.altitudeDeg > 55
        ? 'Exposed direct overhead sunlight'
        : 'Open sun-aligned corridor (no mapped canopy or building shadow)'
    );
  }

  return {
    score: Math.round(score * 100) / 100,
    basis: reasons.join(' · '),
  };
}

/**
 * Generates full local Shade Prediction overlay + road segment shade scores + transparent reliability metadata.
 */
export async function estimateAreaShade(params: {
  lat: number;
  lng: number;
  radiusMeters?: number;
  departureTimeIso?: string;
  cloudCoverPct?: number | null;
}): Promise<ShadePredictionResponse> {
  const lat = params.lat;
  const lng = params.lng;
  const radiusMeters = Math.max(250, Math.min(850, params.radiusMeters ?? 450));
  const departureTimeIso = params.departureTimeIso || new Date().toISOString();
  const cloudCoverPct = params.cloudCoverPct ?? null;

  const sunPosition = getSunPositionInfo(lat, lng, departureTimeIso);
  const osm = await fetchOsmUrbanGeometry(lat, lng, radiusMeters);
  const staticReliefPoints = loadStaticReliefPoints();

  // Include nearby verified shade relief points as explicit canopy/shelter nodes for map & fallback resilience
  const nearbyRelief = staticReliefPoints.filter(
    (rp) => haversineMeters(lat, lng, rp.lat, rp.lng) <= radiusMeters + 350
  );
  const reliefShadeCanopies: TreeCanopyNode[] = nearbyRelief
    .filter((rp) => rp.type === 'shade')
    .map((rp) => ({
      id: `relief-shade-${rp.id}`,
      lat: rp.lat,
      lng: rp.lng,
      radiusMeters: 42,
      source: 'relief-shade',
    }));

  const combinedCanopies: TreeCanopyNode[] = [...osm.trees, ...reliefShadeCanopies];

  const buildingsTotal = osm.buildings.length;
  const buildingsWithMeasuredHeight = osm.buildings.filter(
    (b) => b.heightSource === 'measured-height'
  ).length;
  const buildingsWithLevels = osm.buildings.filter(
    (b) => b.heightSource === 'levels-estimated'
  ).length;
  const buildingsInferredHeight = osm.buildings.filter(
    (b) => b.heightSource === 'footprint-inferred'
  ).length;
  const buildingsMissingHeight = buildingsInferredHeight;

  const buildingShadows: EstimatedShadowPolygon[] = [];
  for (const b of osm.buildings) {
    const poly = projectBuildingShadowPolygon(b, sunPosition);
    if (poly) buildingShadows.push(poly);
  }

  const roadSegments: ShadedRoadSegment[] = [];
  for (const road of osm.roads) {
    if (road.coordinates.length < 2) continue;
    const midIdx = Math.floor(road.coordinates.length / 2);
    const prevIdx = Math.max(0, midIdx - 1);
    const nextIdx = Math.min(road.coordinates.length - 1, midIdx + 1);
    const mid = road.coordinates[midIdx];
    const bearing = computeSegmentBearingDeg(
      road.coordinates[prevIdx][0],
      road.coordinates[prevIdx][1],
      road.coordinates[nextIdx][0],
      road.coordinates[nextIdx][1]
    );

    const scored = scoreCoordinateShade({
      lat: mid[0],
      lng: mid[1],
      sun: sunPosition,
      shadows: buildingShadows,
      trees: combinedCanopies,
      staticShadePoints: staticReliefPoints,
      cloudCoverPct,
      segmentBearingDeg: bearing,
    });

    roadSegments.push({
      id: road.id,
      coordinates: road.coordinates,
      shadeScore: scored.score,
      classification:
        scored.score >= 0.55 ? 'shaded' : scored.score >= 0.25 ? 'partial' : 'sunny',
      basis: scored.basis,
    });
  }

  // Honest reliability & estimation mode determination
  let level: ShadeReliabilityLevel = 'low';
  let estimationMode: ShadeReliabilitySummary['estimationMode'] = 'solar-and-relief-fallback';
  let reason = '';

  const withExplicitHeight = buildingsWithMeasuredHeight + buildingsWithLevels;
  const totalCanopyFeatures = osm.treesCount + osm.parksCount + osm.greenZonesCount;

  if (osm.dataSource === 'unavailable') {
    level = 'low';
    estimationMode = 'solar-and-relief-fallback';
    reason =
      osm.fetchNote ||
      `Overpass building/tree layers were slow or unreachable. Fallback estimate uses SunCalc solar angle, street orientation, and ${nearbyRelief.length} nearby verified relief spots from data/relief-points.json.`;
  } else if (buildingsTotal === 0 && totalCanopyFeatures === 0) {
    level = 'low';
    estimationMode = 'solar-and-relief-fallback';
    reason = `No OSM building footprints or canopy polygons mapped in this radius. Fallback estimate uses solar angle and ${nearbyRelief.length} nearby verified relief spots.`;
  } else if (
    buildingsWithMeasuredHeight >= 5 ||
    (withExplicitHeight >= 10 && totalCanopyFeatures >= 3)
  ) {
    level = 'high';
    estimationMode = 'measured-osm';
    reason = `Computed from SunCalc solar geometry, ${buildingsWithMeasuredHeight} height-tagged + ${buildingsWithLevels} level-tagged buildings, ${buildingsInferredHeight} baseline-inferred footprints (8–12m), and ${totalCanopyFeatures} canopy/green zones.`;
  } else {
    level = 'moderate';
    estimationMode = 'inferred-footprint-and-canopy';
    reason = `Estimated using ${withExplicitHeight} explicitly tagged buildings, ${buildingsInferredHeight} untagged footprints inferred at 8–12m baseline height, ${totalCanopyFeatures} OSM trees/parks/forests/meadows, and ${nearbyRelief.length} nearby verified relief spots.`;
  }

  return {
    center: { lat, lng },
    departureTimeIso: sunPosition.timestampIso,
    sunPosition,
    buildingShadows,
    roadSegments,
    treeCanopies: combinedCanopies,
    reliability: {
      level,
      dataSource: osm.dataSource,
      estimationMode,
      buildingsTotal,
      buildingsWithMeasuredHeight,
      buildingsWithLevels,
      buildingsInferredHeight,
      buildingsMissingHeight,
      treesFound: osm.treesCount,
      parksFound: osm.parksCount,
      greenZonesFound: osm.greenZonesCount,
      nearbyReliefPointsUsed: nearbyRelief.length,
      cloudCoverPct,
      reason,
    },
    disclaimer:
      'Shade overlays combine SunCalc solar geometry with OpenStreetMap heights, inferred 8–12m baseline footprints where height tags are missing, mapped green canopies, and verified relief shelters. Results are estimates—not guaranteed continuous shade.',
  };
}
