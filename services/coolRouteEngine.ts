import fs from 'fs';
import path from 'path';
import {
  CoolRouteOption,
  CoolRouteResponse,
  ReliefPoint,
  RoutePointRef,
} from '../src/types';
import {
  calculateRothfusz,
  fetchOpenMeteoJson,
  getChennaiCurrentHour,
  getRiskLevel,
  roundCoordKey,
} from './weather';
import {
  computeSegmentBearingDeg,
  estimateAreaShade,
  getSunPositionInfo,
  haversineMeters,
  scoreCoordinateShade,
} from './shadeEngine';

function loadStaticReliefPoints(): ReliefPoint[] {
  try {
    const filePath = path.join(process.cwd(), 'data', 'relief-points.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ReliefPoint[];
  } catch {
    return [];
  }
}

interface RawCandidateRoute {
  coordinates: [number, number][];
  distanceMeters: number;
  walkingMinutes: number;
  routingSource: 'osrm-foot' | 'corridor-fallback';
  viaLabel?: string;
}

function polylineDistanceMeters(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return Math.round(total);
}

/**
 * Fetches pedestrian routes via OSRM public foot router.
 * Supports multi-waypoint routing (through shade/water relief stops, green parks, or parallel side-street offsets).
 */
async function fetchOsrmFootRoutes(
  waypoints: Array<{ lat: number; lng: number }>,
  viaLabel?: string
): Promise<RawCandidateRoute[]> {
  const coordsParam = waypoints
    .map((w) => `${w.lng.toFixed(5)},${w.lat.toFixed(5)}`)
    .join(';');
  const url = `https://router.project-osrm.org/route/v1/foot/${coordsParam}?alternatives=3&overview=full&geometries=geojson`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'ChennaiHeatGuard/1.1' },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as { code?: string; routes?: any[] };
    if (json.code !== 'Ok' || !Array.isArray(json.routes)) return [];

    return json.routes
      .filter((r) => Array.isArray(r.geometry?.coordinates) && r.geometry.coordinates.length >= 2)
      .map((r) => {
        const coords: [number, number][] = r.geometry.coordinates.map(
          ([lng, lat]: [number, number]) => [lat, lng]
        );
        const dist =
          typeof r.distance === 'number'
            ? Math.round(r.distance)
            : polylineDistanceMeters(coords);
        // Realistic Chennai walking pace ~75 m/min (4.5 km/h)
        const walkMins = Math.max(1, Math.round(dist / 75));
        return {
          coordinates: coords,
          distanceMeters: dist,
          walkingMinutes: walkMins,
          routingSource: 'osrm-foot' as const,
          viaLabel,
        };
      });
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/**
 * Uses shared rate-limit-safe Open-Meteo TTL cache (12 min per rounded coordinate)
 * so CoolRoute calculations never spam Open-Meteo with HTTP 429 errors.
 */
async function fetchRouteWeatherAtDeparture(
  lat: number,
  lng: number,
  departureIso: string
): Promise<{
  temp: number;
  humidity: number;
  heatIndex: number;
  cloudCoverPct: number | null;
  isLive: boolean;
}> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=temperature_2m,relative_humidity_2m,cloud_cover&timezone=Asia/Kolkata&forecast_days=3`;
  const cacheKey = `route-wx:${roundCoordKey(lat, lng, 2)}`;

  try {
    const { data: json } = await fetchOpenMeteoJson<{
      hourly?: {
        time: string[];
        temperature_2m: number[];
        relative_humidity_2m: number[];
        cloud_cover?: number[];
      };
    }>(url, cacheKey, {
      ttlMs: 12 * 60 * 1000,
      timeoutMs: 6500,
      maxRetries: 2,
      allowStaleOnError: true,
    });

    const depMs = new Date(departureIso).getTime();
    let bestIdx = getChennaiCurrentHour();

    if (Array.isArray(json.hourly?.time) && !Number.isNaN(depMs)) {
      let minDiff = Infinity;
      json.hourly.time.forEach((iso, idx) => {
        const diff = Math.abs(new Date(iso).getTime() - depMs);
        if (diff < minDiff) {
          minDiff = diff;
          bestIdx = idx;
        }
      });
    }

    const temp = Math.round((json.hourly?.temperature_2m?.[bestIdx] ?? 32) * 10) / 10;
    const humidity = Math.round(json.hourly?.relative_humidity_2m?.[bestIdx] ?? 65);
    const cloudCoverPct =
      typeof json.hourly?.cloud_cover?.[bestIdx] === 'number'
        ? Math.round(json.hourly.cloud_cover[bestIdx])
        : null;
    const heatIndex = calculateRothfusz(temp, humidity);

    return { temp, humidity, heatIndex, cloudCoverPct, isLive: true };
  } catch {
    return {
      temp: 32,
      humidity: 65,
      heatIndex: calculateRothfusz(32, 65),
      cloudCoverPct: null,
      isLive: false,
    };
  }
}

/**
 * Samples evenly spaced points along a polyline for shade evaluation & path comparison.
 */
function samplePolylinePoints(
  coords: [number, number][],
  maxSamples = 20
): [number, number][] {
  if (coords.length <= maxSamples) return coords;
  const sampled: [number, number][] = [];
  const step = (coords.length - 1) / (maxSamples - 1);
  for (let i = 0; i < maxSamples; i++) {
    const idx = Math.min(coords.length - 1, Math.round(i * step));
    sampled.push(coords[idx]);
  }
  return sampled;
}

/**
 * Measures average geometric separation (meters) between two routes across interior sample points.
 * Routes separated by >= 40m on average are considered genuinely distinct paths.
 */
function averageRouteSeparationMeters(
  coordsA: [number, number][],
  coordsB: [number, number][]
): number {
  const a = samplePolylinePoints(coordsA, 10);
  const b = samplePolylinePoints(coordsB, 10);
  if (a.length < 3 || b.length < 3) {
    return haversineMeters(
      a[Math.floor(a.length / 2)][0],
      a[Math.floor(a.length / 2)][1],
      b[Math.floor(b.length / 2)][0],
      b[Math.floor(b.length / 2)][1]
    );
  }
  // Compare interior points (skipping exact origin/destination endpoints)
  let totalMinDist = 0;
  const interior = a.slice(1, a.length - 1);
  for (const ptA of interior) {
    let minD = Infinity;
    for (const ptB of b) {
      const d = haversineMeters(ptA[0], ptA[1], ptB[0], ptB[1]);
      if (d < minD) minD = d;
    }
    totalMinDist += minD;
  }
  return totalMinDist / Math.max(1, interior.length);
}

function findReliefPointsNearRoute(
  routeCoords: [number, number][],
  reliefPoints: ReliefPoint[],
  maxDistMeters = 320
): RoutePointRef[] {
  const samples = samplePolylinePoints(routeCoords, 24);
  const matched: RoutePointRef[] = [];

  for (const rp of reliefPoints) {
    let minD = Infinity;
    for (const pt of samples) {
      const d = haversineMeters(pt[0], pt[1], rp.lat, rp.lng);
      if (d < minD) minD = d;
    }
    if (minD <= maxDistMeters) {
      matched.push({
        id: rp.id,
        name: rp.name,
        name_ta: rp.name_ta,
        type: rp.type,
        lat: rp.lat,
        lng: rp.lng,
        distanceFromRouteMeters: Math.round(minD),
        verified: rp.verified,
      });
    }
  }

  return matched.sort((a, b) => a.distanceFromRouteMeters - b.distanceFromRouteMeters);
}

/**
 * Generates left & right perpendicular offset waypoints near the route midpoint so OSRM discovers
 * parallel residential/shaded side streets in addition to the main fastest road.
 */
function buildLateralOffsetWaypoints(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  spanMeters: number
): Array<{ lat: number; lng: number; label: string }> {
  const midLat = (origin.lat + destination.lat) / 2;
  const midLng = (origin.lng + destination.lng) / 2;
  const bearingDeg = computeSegmentBearingDeg(origin.lat, origin.lng, destination.lat, destination.lng);
  const offsetMeters = Math.max(130, Math.min(420, Math.round(spanMeters * 0.2)));
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

  const project = (perpBearingDeg: number, label: string) => {
    const rad = (perpBearingDeg * Math.PI) / 180;
    const dNorth = Math.cos(rad) * offsetMeters;
    const dEast = Math.sin(rad) * offsetMeters;
    return {
      lat: Number((midLat + dNorth / 111320).toFixed(5)),
      lng: Number((midLng + dEast / (111320 * cosLat)).toFixed(5)),
      label,
    };
  };

  return [
    project((bearingDeg + 90) % 360, 'East/Right side-street corridor'),
    project((bearingDeg + 270) % 360, 'West/Left side-street corridor'),
  ];
}

/**
 * Builds CoolRoute comparisons: Fastest, Most Shaded, and Balanced routes.
 * Ensures distinct candidate street paths and distinct shade/relief scores whenever alternatives exist.
 */
export async function computeCoolRoutes(params: {
  origin: { lat: number; lng: number; label?: string };
  destination: { lat: number; lng: number; label?: string };
  departureTimeIso?: string;
}): Promise<CoolRouteResponse> {
  const origin = {
    lat: params.origin.lat,
    lng: params.origin.lng,
    label: params.origin.label || 'Origin',
  };
  const destination = {
    lat: params.destination.lat,
    lng: params.destination.lng,
    label: params.destination.label || 'Destination',
  };
  const departureTimeIso = params.departureTimeIso || new Date().toISOString();
  const midLat = (origin.lat + destination.lat) / 2;
  const midLng = (origin.lng + destination.lng) / 2;
  const spanMeters = haversineMeters(origin.lat, origin.lng, destination.lat, destination.lng);

  const weather = await fetchRouteWeatherAtDeparture(midLat, midLng, departureTimeIso);
  const sunPosition = getSunPositionInfo(midLat, midLng, departureTimeIso);
  const reliefPoints = loadStaticReliefPoints();

  // Fetch Shade Prediction around route corridor midpoint (deduplicated & cached in shadeEngine)
  const shadeField = await estimateAreaShade({
    lat: midLat,
    lng: midLng,
    radiusMeters: Math.min(1050, Math.max(480, Math.round(spanMeters * 0.7))),
    departureTimeIso,
    cloudCoverPct: weather.cloudCoverPct,
  });

  // 1. Identify nearby shade/water/cooling relief points along the corridor to generate relief-guided alternatives
  const corridorReliefStops = reliefPoints
    .map((rp) => {
      const dDirect = Math.max(80, spanMeters);
      const dVia =
        haversineMeters(origin.lat, origin.lng, rp.lat, rp.lng) +
        haversineMeters(rp.lat, rp.lng, destination.lat, destination.lng);
      const dFromOrigin = haversineMeters(origin.lat, origin.lng, rp.lat, rp.lng);
      const dFromDest = haversineMeters(destination.lat, destination.lng, rp.lat, rp.lng);
      return {
        rp,
        detourRatio: dVia / dDirect,
        minEndDist: Math.min(dFromOrigin, dFromDest),
      };
    })
    // Exclude points right on top of start/end so via-routing actually creates a real detour corridor
    .filter((item) => item.detourRatio <= 1.85 && item.minEndDist >= 90)
    .sort((a, b) => {
      const typeBoostA = a.rp.type === 'shade' ? -0.1 : a.rp.type === 'water' ? -0.05 : 0;
      const typeBoostB = b.rp.type === 'shade' ? -0.1 : b.rp.type === 'water' ? -0.05 : 0;
      return a.detourRatio + typeBoostA - (b.detourRatio + typeBoostB);
    })
    .slice(0, 2);

  // 2. Nearest OSM green canopy node (park, forest, meadow) inside corridor
  const greenVia = shadeField.treeCanopies
    .filter(
      (t) =>
        (t.source === 'osm-park' || t.source === 'osm-forest' || t.source === 'osm-meadow') &&
        haversineMeters(origin.lat, origin.lng, t.lat, t.lng) >= 100 &&
        haversineMeters(destination.lat, destination.lng, t.lat, t.lng) >= 100
    )
    .slice(0, 1);

  // 3. Lateral left/right street offsets so OSRM finds distinct parallel walking streets even when relief points are sparse
  const lateralOffsets =
    spanMeters >= 200 ? buildLateralOffsetWaypoints(origin, destination, spanMeters) : [];

  // Query OSRM foot router in parallel across all candidate strategies
  const routeBatches = await Promise.all([
    fetchOsrmFootRoutes([origin, destination], 'Direct walking corridor'),
    ...corridorReliefStops.map((stop) =>
      fetchOsrmFootRoutes(
        [origin, { lat: stop.rp.lat, lng: stop.rp.lng }, destination],
        `Via ${stop.rp.name}`
      )
    ),
    ...greenVia.map((gv) =>
      fetchOsrmFootRoutes([origin, { lat: gv.lat, lng: gv.lng }, destination], 'Via green park/canopy corridor')
    ),
    ...lateralOffsets.map((lo) =>
      fetchOsrmFootRoutes([origin, { lat: lo.lat, lng: lo.lng }, destination], lo.label)
    ),
  ]);

  const allFetchedRoutes = routeBatches.flat();
  const minFetchedWalkDist =
    allFetchedRoutes.length > 0
      ? Math.min(...allFetchedRoutes.map((r) => r.distanceMeters))
      : Math.max(200, spanMeters);

  const rawCandidates: RawCandidateRoute[] = allFetchedRoutes
    // Guard against extreme accidental detours (>1.65x the actual shortest street walk)
    .filter(
      (c) =>
        minFetchedWalkDist < 120 ||
        c.distanceMeters <= Math.max(minFetchedWalkDist * 1.65, minFetchedWalkDist + 900)
    );

  // De-duplicate ONLY genuinely overlapping geometries (< 40m average path separation)
  const distinctCandidates: RawCandidateRoute[] = [];
  const sortedByLength = [...rawCandidates].sort((a, b) => a.distanceMeters - b.distanceMeters);
  for (const cand of sortedByLength) {
    const isDuplicate = distinctCandidates.some(
      (kept) =>
        averageRouteSeparationMeters(kept.coordinates, cand.coordinates) < 40 &&
        Math.abs(kept.distanceMeters - cand.distanceMeters) < 90
    );
    if (!isDuplicate) {
      distinctCandidates.push(cand);
    }
  }

  let candidates = distinctCandidates;

  // Graceful fallback if OSRM street router is unreachable or returned no routes
  if (candidates.length === 0) {
    const directDist = Math.max(80, Math.round(spanMeters));
    const offsets = buildLateralOffsetWaypoints(origin, destination, Math.max(300, spanMeters));
    const viaRelief = corridorReliefStops[0]
      ? [corridorReliefStops[0].rp.lat, corridorReliefStops[0].rp.lng] as [number, number]
      : [offsets[0].lat, offsets[0].lng] as [number, number];

    const directCoords: [number, number][] = [
      [origin.lat, origin.lng],
      [destination.lat, destination.lng],
    ];
    const shadedCoords: [number, number][] = [
      [origin.lat, origin.lng],
      viaRelief,
      [destination.lat, destination.lng],
    ];
    const balancedCoords: [number, number][] = [
      [origin.lat, origin.lng],
      [offsets[1].lat, offsets[1].lng],
      [destination.lat, destination.lng],
    ];

    const shadedDist = Math.max(Math.round(directDist * 1.12), polylineDistanceMeters(shadedCoords));
    const balancedDist = Math.max(Math.round(directDist * 1.07), polylineDistanceMeters(balancedCoords));

    candidates = [
      {
        coordinates: directCoords,
        distanceMeters: directDist,
        walkingMinutes: Math.max(1, Math.round(directDist / 75)),
        routingSource: 'corridor-fallback',
        viaLabel: 'Direct corridor fallback',
      },
      {
        coordinates: shadedCoords,
        distanceMeters: shadedDist,
        walkingMinutes: Math.max(1, Math.round(shadedDist / 75)),
        routingSource: 'corridor-fallback',
        viaLabel: corridorReliefStops[0]
          ? `Corridor via ${corridorReliefStops[0].rp.name}`
          : 'Side-corridor shade fallback',
      },
      {
        coordinates: balancedCoords,
        distanceMeters: balancedDist,
        walkingMinutes: Math.max(1, Math.round(balancedDist / 75)),
        routingSource: 'corridor-fallback',
        viaLabel: 'Balanced alternate corridor fallback',
      },
    ];
  }

  // Score every candidate route with point-by-point Shade Prediction (including segment bearing) + Relief Locator proximity
  const evaluated = candidates.map((cand) => {
    const samples = samplePolylinePoints(cand.coordinates, 22);
    const pointScores = samples.map((pt, idx) => {
      const prev = samples[Math.max(0, idx - 1)];
      const next = samples[Math.min(samples.length - 1, idx + 1)];
      const bearing =
        prev[0] !== next[0] || prev[1] !== next[1]
          ? computeSegmentBearingDeg(prev[0], prev[1], next[0], next[1])
          : null;

      return scoreCoordinateShade({
        lat: pt[0],
        lng: pt[1],
        sun: sunPosition,
        shadows: shadeField.buildingShadows,
        trees: shadeField.treeCanopies,
        staticShadePoints: reliefPoints,
        cloudCoverPct: weather.cloudCoverPct,
        segmentBearingDeg: bearing,
      });
    });

    const nearbyReliefPoints = findReliefPointsNearRoute(cand.coordinates, reliefPoints, 320);
    const nearbyWaterCount = nearbyReliefPoints.filter((r) => r.type === 'water').length;
    const nearbyShadeCount = nearbyReliefPoints.filter((r) => r.type === 'shade').length;
    const nearbyCoolingCount = nearbyReliefPoints.filter((r) => r.type === 'cooling').length;

    // Continuous relief-proximity lift (rewards routes passing close to verified shade/water/cooling shelters)
    const closestReliefDist = nearbyReliefPoints[0]?.distanceFromRouteMeters ?? 999;
    const reliefCorridorBonus = Math.min(
      14,
      nearbyShadeCount * 4.5 +
        nearbyWaterCount * 3.0 +
        nearbyCoolingCount * 3.5 +
        (closestReliefDist < 120 ? 3.5 : closestReliefDist < 240 ? 1.5 : 0)
    );

    const rawAvgShadePct =
      (pointScores.reduce((sum, s) => sum + s.score, 0) / Math.max(1, pointScores.length)) * 100;
    const estimatedShadePct = Math.min(96, Math.round(rawAvgShadePct + reliefCorridorBonus * 0.45));

    const shadedSegmentSharePct = Math.round(
      (pointScores.filter((s) => s.score >= 0.45).length / Math.max(1, pointScores.length)) * 100
    );

    // Composite thermal-relief preference score for ranking Most Shaded & Balanced
    const coolingUtilityScore =
      estimatedShadePct +
      nearbyShadeCount * 6 +
      nearbyWaterCount * 5 +
      nearbyCoolingCount * 4;

    // Effective perceived thermal reduction (~0 to 2.5°C cooler sensation in shaded canopy vs open sun)
    const shadeCoolReduction = (estimatedShadePct / 100) * 2.5;
    const exposureHeatIndex = Math.round((weather.heatIndex - shadeCoolReduction) * 10) / 10;

    return {
      ...cand,
      estimatedShadePct,
      shadedSegmentSharePct,
      nearbyWaterCount,
      nearbyShadeCount,
      nearbyReliefPoints,
      coolingUtilityScore,
      exposureHeatIndex,
      exposureRisk: getRiskLevel(exposureHeatIndex),
    };
  });

  // 1. Fastest Route: strictly shortest walking distance / time
  const byFastest = [...evaluated].sort((a, b) => a.distanceMeters - b.distanceMeters);
  const fastestPick = byFastest[0];

  // 2. Most Shaded Route: highest cooling/shade utility, preferring a distinct street path when available
  const byShaded = [...evaluated].sort(
    (a, b) =>
      b.coolingUtilityScore - a.coolingUtilityScore ||
      b.estimatedShadePct - a.estimatedShadePct ||
      a.distanceMeters - b.distanceMeters
  );
  const bestDistinctShaded = byShaded.find((c) => c !== fastestPick);
  const mostShadedPick =
    bestDistinctShaded &&
    (bestDistinctShaded.coolingUtilityScore >= fastestPick.coolingUtilityScore - 4 ||
      evaluated.length >= 2)
      ? bestDistinctShaded
      : byShaded[0];

  // 3. Balanced Route: best trade-off between shade/water access and walking distance; prefer a 3rd distinct path when available
  const minDist = Math.max(1, fastestPick.distanceMeters);
  const byBalanced = [...evaluated].sort((a, b) => {
    const overheadA = (a.distanceMeters - minDist) / minDist;
    const overheadB = (b.distanceMeters - minDist) / minDist;
    const scoreA = a.coolingUtilityScore / 100 - overheadA * 0.48;
    const scoreB = b.coolingUtilityScore / 100 - overheadB * 0.48;
    return scoreB - scoreA;
  });
  const balancedPick =
    byBalanced.find((c) => c !== fastestPick && c !== mostShadedPick) ||
    byBalanced.find((c) => c !== fastestPick) ||
    byBalanced[0];

  const relSummary = shadeField.reliability;
  const hasCorridorFallback = [fastestPick, mostShadedPick, balancedPick].some(
    (p) => p.routingSource === 'corridor-fallback'
  );

  let reliabilityWarning: string | null = null;
  if (hasCorridorFallback) {
    reliabilityWarning =
      'Street routing service (OSRM) was temporarily unreachable; showing fallback walking corridors. Distance and shade coverage are coarse estimates.';
  } else if (relSummary.level === 'low') {
    reliabilityWarning = `Fallback shade estimate (${relSummary.level} reliability): ${relSummary.reason}`;
  } else if (relSummary.estimationMode === 'inferred-footprint-and-canopy') {
    reliabilityWarning = `Estimated shade (${relSummary.level} reliability): ${relSummary.reason}`;
  }

  const buildShadeBasisNote = (pick: (typeof evaluated)[number]) => {
    const viaHint = pick.viaLabel ? `${pick.viaLabel} · ` : '';
    if (pick.routingSource === 'corridor-fallback') {
      return `${viaHint}Fallback walking corridor (OSRM unreachable); shade & distance are rough estimates.`;
    }
    if (relSummary.estimationMode === 'solar-and-relief-fallback') {
      return `${viaHint}Fallback estimate from SunCalc solar angle (${sunPosition.altitudeDeg}°), street orientation, and ${pick.nearbyReliefPoints.length} nearby verified relief spot(s).`;
    }
    if (relSummary.estimationMode === 'inferred-footprint-and-canopy') {
      return `${viaHint}Estimated via SunCalc (${sunPosition.altitudeDeg}°), ${relSummary.buildingsInferredHeight} baseline-inferred footprints (8–12m), ${relSummary.treesFound + relSummary.parksFound + relSummary.greenZonesFound} mapped trees/parks/green zones, and nearby relief points.`;
    }
    return `${viaHint}Estimated via SunCalc (${sunPosition.altitudeDeg}°), ${relSummary.buildingsWithMeasuredHeight + relSummary.buildingsWithLevels} height/level-tagged + ${relSummary.buildingsInferredHeight} baseline buildings, and ${relSummary.treesFound + relSummary.parksFound + relSummary.greenZonesFound} canopy zones.`;
  };

  const toRouteOption = (
    pick: (typeof evaluated)[number],
    profile: CoolRouteOption['profile'],
    title: string,
    titleTa: string,
    subtitle: string,
    isDistinctPath: boolean
  ): CoolRouteOption => ({
    profile,
    title,
    titleTa,
    subtitle,
    coordinates: pick.coordinates,
    distanceMeters: pick.distanceMeters,
    walkingMinutes: pick.walkingMinutes,
    estimatedShadePct: pick.estimatedShadePct,
    shadedSegmentSharePct: pick.shadedSegmentSharePct,
    nearbyWaterCount: pick.nearbyWaterCount,
    nearbyShadeCount: pick.nearbyShadeCount,
    nearbyReliefPoints: pick.nearbyReliefPoints,
    exposureHeatIndex: pick.exposureHeatIndex,
    exposureRisk: pick.exposureRisk,
    reliability: relSummary.level,
    estimationMode: relSummary.estimationMode,
    shadeBasisNote: buildShadeBasisNote(pick),
    routingSource: pick.routingSource,
    isDistinctPath,
  });

  const routes: CoolRouteOption[] = [
    toRouteOption(
      fastestPick,
      'fastest',
      'Fastest Route',
      'விரைவான வழி',
      'Prioritizes shortest walking time',
      true
    ),
    toRouteOption(
      mostShadedPick,
      'most-shaded',
      'Most Shaded Route',
      'அதிக நிழல் வழி',
      'Prioritizes estimated shade & water relief',
      mostShadedPick !== fastestPick
    ),
    toRouteOption(
      balancedPick,
      'balanced',
      'Balanced Route',
      'சமநிலையான வழி',
      'Balances walking speed with cooler cover',
      balancedPick !== fastestPick && balancedPick !== mostShadedPick
    ),
  ];

  return {
    origin,
    destination,
    departureTimeIso: sunPosition.timestampIso,
    sunPosition,
    reliability: relSummary,
    weatherSummary: {
      temp: weather.temp,
      humidity: weather.humidity,
      heatIndex: weather.heatIndex,
      cloudCoverPct: weather.cloudCoverPct,
      risk: getRiskLevel(weather.heatIndex),
      isLive: weather.isLive,
    },
    routes,
    shadeDisclaimer:
      'Shade percentages are estimates derived from solar geometry, available or baseline-inferred (8–12m) building footprints, green canopies, and verified relief proximity—never a guarantee of continuous physical shade.',
    reliabilityWarning,
  };
}
