import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  CoolRouteOption,
  CoolRouteProfileId,
  CoolRouteResponse,
  Language,
  MapBaseStyle,
  MonitoredLocation,
  ReliefPoint,
  ShadePredictionResponse,
  ZoneDetail,
} from '../../types';
import { fetchEnabledMonitoredLocationsFromFirestore } from '../../services/firebase';
import { fetchCoolRoutes, fetchShadePrediction } from '../../services/intelligenceApi';
import { attachBaseLayer } from '../../utils/mapTiles';
import {
  formatChennaiTimeLabel,
  getInitialSunDepartureState,
  getNextChennaiMiddaySunDate,
  toLocalDateTimeInputValue,
} from '../../utils/sunPreview';
import { RISK_CONFIG } from '../../utils/heatIndex';
import { PlaceOption, PlaceSearchInput } from './PlaceSearchInput';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Droplets,
  ExternalLink,
  Locate,
  Map as MapIcon,
  MapPin,
  Moon,
  Navigation,
  RefreshCw,
  Route,
  Satellite,
  ShieldAlert,
  Sun,
  Umbrella,
} from 'lucide-react';

interface Props {
  zones: ZoneDetail[];
  reliefPoints: ReliefPoint[];
  selectedZoneId: string;
  userCoords: { lat: number; lng: number } | null;
  onLocateMe: () => void;
  isLocating: boolean;
  lang: Language;
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

const ROUTE_COLORS: Record<CoolRouteProfileId, string> = {
  fastest: '#ea580c',
  'most-shaded': '#059669',
  balanced: '#0284c7',
};

function getEstimationModeMeta(mode: CoolRouteOption['estimationMode'] | undefined) {
  if (mode === 'measured-osm') {
    return {
      label: 'Estimated (OSM Heights + Canopy)',
      shortLabel: 'OSM Measured Estimate',
      badgeClass:
        'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
    };
  }
  if (mode === 'inferred-footprint-and-canopy') {
    return {
      label: 'Estimated (Inferred 8–12m Buildings + Canopy/Relief)',
      shortLabel: 'Inferred 8–12m + Relief',
      badgeClass:
        'bg-indigo-50 text-indigo-800 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800',
    };
  }
  return {
    label: 'Fallback Estimate (Sun Angle + Verified Relief Spots)',
    shortLabel: 'Fallback Estimate',
    badgeClass:
      'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
  };
}

export const WorkerCoolRoute: React.FC<Props> = ({
  zones,
  reliefPoints,
  selectedZoneId,
  userCoords,
  onLocateMe,
  isLocating,
  lang,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const baseTileLayerRef = useRef<L.Layer | null>(null);
  const shadeGroupRef = useRef<L.LayerGroup | null>(null);
  const routeGroupRef = useRef<L.LayerGroup | null>(null);
  const reliefGroupRef = useRef<L.LayerGroup | null>(null);
  const pendingGpsOriginRef = useRef<boolean>(false);

  const [firestoreLocations, setFirestoreLocations] = useState<MonitoredLocation[]>([]);

  useEffect(() => {
    fetchEnabledMonitoredLocationsFromFirestore().then(setFirestoreLocations);
  }, []);

  // Build unified place catalog reusing zones, static shade/water/cooling locator, and Firestore monitoredLocations
  const placeOptions = useMemo<PlaceOption[]>(() => {
    const list: PlaceOption[] = [];
    if (userCoords) {
      list.push({
        id: 'gps:current',
        label: lang === 'ta' ? 'என் இருப்பிடம் (GPS)' : 'Your current GPS location',
        group: 'GPS',
        lat: userCoords.lat,
        lng: userCoords.lng,
      });
    }
    zones.forEach((z) => {
      list.push({
        id: `zone:${z.id}`,
        label: `${lang === 'ta' ? z.name_ta : z.name} (Ward ${z.ward_no})`,
        group: 'Chennai Zones',
        lat: z.lat,
        lng: z.lng,
      });
    });
    firestoreLocations.forEach((ml) => {
      if (!zones.some((z) => z.id === ml.locationId)) {
        list.push({
          id: `fs:${ml.locationId}`,
          label: `${lang === 'ta' ? ml.name_ta || ml.name : ml.name} (${ml.region || 'TN'})`,
          group: 'Monitored Locations',
          lat: ml.lat,
          lng: ml.lng,
        });
      }
    });
    reliefPoints.forEach((rp) => {
      list.push({
        id: `rp:${rp.id}`,
        label: `${lang === 'ta' ? rp.name_ta : rp.name} (${rp.type.toUpperCase()})`,
        group: 'Relief Spots',
        lat: rp.lat,
        lng: rp.lng,
      });
    });
    return list;
  }, [userCoords, zones, firestoreLocations, reliefPoints, lang]);

  const defaultOrigin = useMemo(() => {
    if (userCoords) {
      return {
        id: 'gps:current',
        lat: userCoords.lat,
        lng: userCoords.lng,
        label: 'Your location',
      };
    }
    const z = zones.find((item) => item.id === selectedZoneId) || zones[0];
    return z
      ? { id: `zone:${z.id}`, lat: z.lat, lng: z.lng, label: z.name }
      : { id: 'zone:t-nagar', lat: 13.0418, lng: 80.2341, label: 'T. Nagar' };
  }, [userCoords, zones, selectedZoneId]);

  const defaultDest = useMemo(() => {
    // Pick nearest shade/water relief point at ~500m-2500m away from origin for a helpful initial route
    const candidates = reliefPoints
      .filter((rp) => rp.type === 'shade' || rp.type === 'water' || rp.type === 'cooling')
      .map((rp) => {
        const dLat = (rp.lat - defaultOrigin.lat) * 111320;
        const dLng = (rp.lng - defaultOrigin.lng) * 111320 * Math.cos((defaultOrigin.lat * Math.PI) / 180);
        return { rp, dist: Math.hypot(dLat, dLng) };
      })
      .sort((a, b) => Math.abs(a.dist - 1200) - Math.abs(b.dist - 1200));

    if (candidates[0]) {
      return {
        id: `rp:${candidates[0].rp.id}`,
        lat: candidates[0].rp.lat,
        lng: candidates[0].rp.lng,
        label: candidates[0].rp.name,
      };
    }
    return {
      id: 'zone:guindy',
      lat: 13.0067,
      lng: 80.2206,
      label: 'Guindy Industrial',
    };
  }, [reliefPoints, defaultOrigin.lat, defaultOrigin.lng]);

  const [originPoint, setOriginPoint] = useState(defaultOrigin);
  const [destPoint, setDestPoint] = useState(defaultDest);
  const [pickMode, setPickMode] = useState<'none' | 'origin' | 'destination'>('none');

  const initialSun = useMemo(() => getInitialSunDepartureState(), []);
  const [departureInput, setDepartureInput] = useState<string>(initialSun.departureInput);
  const [isAutoDaytimePreview, setIsAutoDaytimePreview] = useState<boolean>(
    initialSun.isAutoDaytimePreview
  );
  const [mapStyle, setMapStyle] = useState<MapBaseStyle>('street');
  const [showShadeOverlay, setShowShadeOverlay] = useState<boolean>(true);
  const [showReliefMarkers, setShowReliefMarkers] = useState<boolean>(true);

  const [routeResult, setRouteResult] = useState<CoolRouteResponse | null>(null);
  const [shadeOverlay, setShadeOverlay] = useState<ShadePredictionResponse | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<CoolRouteProfileId>('most-shaded');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedStopList, setExpandedStopList] = useState<CoolRouteProfileId | null>(null);

  // Sync origin if user presses GPS locate inside CoolRoute (including async GPS completion)
  useEffect(() => {
    if (userCoords && (originPoint.id === 'gps:current' || pendingGpsOriginRef.current)) {
      pendingGpsOriginRef.current = false;
      setOriginPoint({
        id: 'gps:current',
        lat: userCoords.lat,
        lng: userCoords.lng,
        label: lang === 'ta' ? 'என் இருப்பிடம் (GPS)' : 'Your location (GPS)',
      });
    }
  }, [userCoords, originPoint.id, lang]);

  // Compute routes + midpoint shade overlay whenever origin, destination, or departure changes
  const runCoolRouteCalculation = async (
    o = originPoint,
    d = destPoint,
    depStr = departureInput,
    signal?: AbortSignal
  ) => {
    setLoading(true);
    setError(null);
    const parsed = new Date(depStr);
    const iso = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
    const midLat = (o.lat + d.lat) / 2;
    const midLng = (o.lng + d.lng) / 2;

    try {
      const [routesRes, shadeRes] = await Promise.all([
        fetchCoolRoutes({
          origin: { lat: o.lat, lng: o.lng, label: o.label },
          destination: { lat: d.lat, lng: d.lng, label: d.label },
          departureTimeIso: iso,
          signal,
        }),
        fetchShadePrediction({
          lat: midLat,
          lng: midLng,
          radiusMeters: 520,
          departureTimeIso: iso,
          signal,
        }),
      ]);
      setRouteResult(routesRes);
      setShadeOverlay(shadeRes);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err?.message || 'Unable to compute CoolRoutes right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    runCoolRouteCalculation(originPoint, destPoint, departureInput, controller.signal);
    return () => controller.abort();
  }, [originPoint.lat, originPoint.lng, destPoint.lat, destPoint.lng, departureInput]);

  // Initialize Leaflet map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [originPoint.lat, originPoint.lng],
      zoom: 15,
      minZoom: 11,
      maxZoom: 19,
    });

    baseTileLayerRef.current = attachBaseLayer(map, null, 'street');
    shadeGroupRef.current = L.layerGroup().addTo(map);
    routeGroupRef.current = L.layerGroup().addTo(map);
    reliefGroupRef.current = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      baseTileLayerRef.current = null;
      shadeGroupRef.current = null;
      routeGroupRef.current = null;
      reliefGroupRef.current = null;
    };
  }, []);

  // Map click handler for Origin / Destination picking
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const onClick = (e: L.LeafletMouseEvent) => {
      if (pickMode === 'none') return;
      const lat = Number(e.latlng.lat.toFixed(5));
      const lng = Number(e.latlng.lng.toFixed(5));
      if (pickMode === 'origin') {
        setOriginPoint({
          id: 'custom:origin',
          lat,
          lng,
          label: `Pinned Start (${lat.toFixed(3)}, ${lng.toFixed(3)})`,
        });
      } else {
        setDestPoint({
          id: 'custom:dest',
          lat,
          lng,
          label: `Pinned Destination (${lat.toFixed(3)}, ${lng.toFixed(3)})`,
        });
      }
      setPickMode('none');
    };

    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [pickMode]);

  // Street <-> Hybrid Satellite tile toggle via same-origin tile proxy
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    baseTileLayerRef.current = attachBaseLayer(map, baseTileLayerRef.current, mapStyle);
  }, [mapStyle]);

  // Render Shade Overlay
  useEffect(() => {
    const group = shadeGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!showShadeOverlay || !shadeOverlay) return;

    shadeOverlay.buildingShadows.forEach((poly) => {
      const sourceLabel =
        poly.source === 'footprint-inferred'
          ? 'inferred baseline footprint (8–12m)'
          : poly.source === 'measured-height'
            ? 'OSM explicit height'
            : poly.source === 'levels-estimated'
              ? 'OSM building levels'
              : 'tree canopy';
      const polygon = L.polygon(poly.coordinates, {
        color: '#312e81',
        fillColor: '#1e1b4b',
        fillOpacity: poly.source === 'footprint-inferred' ? 0.3 : 0.38,
        weight: 1,
        dashArray: '3 3',
      });
      polygon.bindPopup(
        `<div style="font-family:sans-serif;min-width:170px;">
          <div style="font-size:10px;font-weight:800;color:#4338ca;text-transform:uppercase;">Estimated Building Shadow</div>
          <div style="font-size:11px;margin-top:2px;">Source: <b>${sourceLabel}</b> (~${poly.heightMeters}m)</div>
          <div style="font-size:10px;color:#57534e;margin-top:2px;">Estimate only — not guaranteed shade.</div>
        </div>`
      );
      group.addLayer(polygon);
    });

    shadeOverlay.treeCanopies.forEach((tree) => {
      const isRelief = tree.source === 'relief-shade';
      const isForestOrMeadow = tree.source === 'osm-forest' || tree.source === 'osm-meadow';
      const stroke = isRelief ? '#0f766e' : isForestOrMeadow ? '#166534' : '#15803d';
      const fill = isRelief ? '#14b8a6' : isForestOrMeadow ? '#16a34a' : '#22c55e';
      const label =
        tree.source === 'relief-shade'
          ? 'Verified Relief Shade Buffer'
          : tree.source === 'osm-forest'
            ? 'OSM Forest / Wood Canopy'
            : tree.source === 'osm-meadow'
              ? 'OSM Meadow / Green Zone'
              : tree.source === 'osm-park'
                ? 'OSM Park / Garden'
                : 'OSM Tree Canopy';
      const circle = L.circle([tree.lat, tree.lng], {
        radius: tree.radiusMeters,
        color: stroke,
        fillColor: fill,
        fillOpacity: isRelief ? 0.22 : 0.26,
        weight: 1,
        dashArray: isRelief ? '3 3' : undefined,
      });
      circle.bindPopup(
        `<div style="font-family:sans-serif;min-width:160px;">
          <div style="font-size:10px;font-weight:800;color:${stroke};text-transform:uppercase;">${label}</div>
          <div style="font-size:11px;color:#44403c;margin-top:2px;">Radius ~${tree.radiusMeters}m (shade estimate)</div>
        </div>`
      );
      group.addLayer(circle);
    });
  }, [showShadeOverlay, shadeOverlay]);

  // Render Verified Relief Markers
  useEffect(() => {
    const group = reliefGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!showReliefMarkers) return;

    reliefPoints.forEach((rp) => {
      const symbol = rp.type === 'shade' ? '☂️' : rp.type === 'cooling' ? '❄️' : '💧';
      const bg = rp.type === 'shade' ? '#16a34a' : rp.type === 'cooling' ? '#7c3aed' : '#0284c7';
      const icon = L.divIcon({
        className: 'coolroute-relief-pin',
        html: `<div style="background:${bg};color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.4);">${symbol}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const marker = L.marker([rp.lat, rp.lng], { icon });
      marker.bindPopup(
        `<div style="font-family:sans-serif;min-width:165px;">
          <div style="font-size:10px;font-weight:800;color:${bg};text-transform:uppercase;">Verified ${rp.type}</div>
          <div style="font-size:12px;font-weight:800;margin-top:2px;">${lang === 'ta' ? rp.name_ta : rp.name}</div>
          <div style="font-size:11px;color:#57534e;margin-top:2px;">${lang === 'ta' ? rp.address_ta : rp.address}</div>
        </div>`
      );
      group.addLayer(marker);
    });
  }, [showReliefMarkers, reliefPoints, lang]);

  // Render the 3 Comparison Routes + Start/End Pins
  useEffect(() => {
    const map = mapInstanceRef.current;
    const group = routeGroupRef.current;
    if (!map || !group) return;
    group.clearLayers();

    if (routeResult && routeResult.routes.length > 0) {
      // Draw inactive routes underneath, selected route on top
      const ordered = [...routeResult.routes].sort((a, b) =>
        a.profile === selectedProfile ? 1 : b.profile === selectedProfile ? -1 : 0
      );

      ordered.forEach((route) => {
        const isActive = route.profile === selectedProfile;
        const color = ROUTE_COLORS[route.profile];
        const poly = L.polyline(route.coordinates, {
          color,
          weight: isActive ? 6.5 : 3.5,
          opacity: isActive ? 0.95 : 0.55,
          dashArray: isActive ? undefined : '6 6',
        });
        poly.on('click', () => setSelectedProfile(route.profile));
        poly.bindPopup(
          `<div style="font-family:sans-serif;min-width:170px;">
            <b style="color:${color};">${route.title}</b>
            <div style="font-size:11px;margin-top:3px;">
              ${route.walkingMinutes} min · ${formatDistance(route.distanceMeters)}
            </div>
            <div style="font-size:11px;">Est. shade: <b>${route.estimatedShadePct}%</b> (estimate only)</div>
            <div style="font-size:11px;">Water: ${route.nearbyWaterCount} · Shade spots: ${route.nearbyShadeCount}</div>
          </div>`
        );
        group.addLayer(poly);
      });
    }

    // Start & Destination Pins
    const startIcon = L.divIcon({
      className: 'coolroute-start-pin',
      html: `<div style="background:#1c1917;color:#fff;font-size:10px;font-weight:900;padding:3px 7px;border-radius:8px;border:2px solid #22c55e;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4);">START</div>`,
      iconSize: [46, 22],
      iconAnchor: [23, 11],
    });
    const endIcon = L.divIcon({
      className: 'coolroute-end-pin',
      html: `<div style="background:#1c1917;color:#fff;font-size:10px;font-weight:900;padding:3px 7px;border-radius:8px;border:2px solid #ef4444;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4);">GOAL</div>`,
      iconSize: [44, 22],
      iconAnchor: [22, 11],
    });

    group.addLayer(L.marker([originPoint.lat, originPoint.lng], { icon: startIcon, zIndexOffset: 900 }));
    group.addLayer(L.marker([destPoint.lat, destPoint.lng], { icon: endIcon, zIndexOffset: 900 }));

    // Fit map cleanly around origin & destination
    const bounds = L.latLngBounds(
      [originPoint.lat, originPoint.lng],
      [destPoint.lat, destPoint.lng]
    );
    if (routeResult) {
      routeResult.routes.forEach((r) => r.coordinates.forEach((c) => bounds.extend(c)));
    }
    map.fitBounds(bounds.pad(0.22), { maxZoom: 16 });
  }, [routeResult, selectedProfile, originPoint, destPoint]);

  const activeRoute: CoolRouteOption | null = useMemo(() => {
    if (!routeResult) return null;
    return routeResult.routes.find((r) => r.profile === selectedProfile) || routeResult.routes[0] || null;
  }, [routeResult, selectedProfile]);

  const setPresetDeparture = (offsetMins: number | 'noon') => {
    setIsAutoDaytimePreview(false);
    if (offsetMins === 'noon') {
      const midday = getNextChennaiMiddaySunDate(new Date());
      setDepartureInput(toLocalDateTimeInputValue(midday));
      return;
    }
    const base = new Date();
    base.setMinutes(base.getMinutes() + offsetMins);
    setDepartureInput(toLocalDateTimeInputValue(base));
  };

  const handleSwapEndpoints = () => {
    setOriginPoint(destPoint);
    setDestPoint(originPoint);
  };

  return (
    <div className="max-w-5xl mx-auto px-3.5 sm:px-6 py-4 space-y-4 pb-24">
      {/* Header Banner */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-4 border border-stone-200 dark:border-stone-800 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
              <Route className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-black text-stone-900 dark:text-white">
                {lang === 'ta'
                  ? 'CoolRoute — நிழல் & குளிர் வழித் திட்டமிடல்'
                  : 'CoolRoute — Shade & Relief Walking Navigation'}
              </h1>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                {lang === 'ta'
                  ? 'எந்தத் தெரு அல்லது அடையாளத்தையும் தேடுங்கள் — வேகமான, அதிக நிழல் & சமநிலையான வழிகளை ஒப்பிடுங்கள்'
                  : 'Search any Chennai street or landmark and compare Fastest, Most Shaded & Balanced walking paths'}
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            pendingGpsOriginRef.current = true;
            onLocateMe();
            if (userCoords) {
              pendingGpsOriginRef.current = false;
              setOriginPoint({
                id: 'gps:current',
                lat: userCoords.lat,
                lng: userCoords.lng,
                label: lang === 'ta' ? 'என் இருப்பிடம் (GPS)' : 'Your location (GPS)',
              });
            }
          }}
          disabled={isLocating}
          className="inline-flex items-center justify-center gap-1.5 min-h-[42px] px-3.5 py-2 rounded-xl bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200 dark:border-blue-800 text-xs font-bold cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <Locate className={`w-4 h-4 ${isLocating ? 'animate-spin' : ''}`} />
          <span>{isLocating ? 'Locating...' : 'Use GPS Origin'}</span>
        </button>
      </div>

      {/* Trip Controls: Street/Landmark Search, Swap & Departure Time */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-4 border border-stone-200 dark:border-stone-800 shadow-sm space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_1fr] gap-3 items-start">
          {/* Origin Street / Landmark Search */}
          <PlaceSearchInput
            id="coolroute-origin"
            label="Start Point"
            placeholder="Search street, station, or area (e.g. Pondy Bazaar)..."
            value={originPoint}
            localOptions={placeOptions}
            onSelect={setOriginPoint}
            isPickingOnMap={pickMode === 'origin'}
            onTogglePickOnMap={() => setPickMode((m) => (m === 'origin' ? 'none' : 'origin'))}
          />

          {/* Swap Start <-> Destination */}
          <div className="flex md:pt-5 justify-center">
            <button
              type="button"
              onClick={handleSwapEndpoints}
              title="Swap start and destination"
              aria-label="Swap start and destination"
              className="min-h-[42px] min-w-[42px] px-2.5 rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 hover:bg-stone-100 dark:hover:bg-stone-800 text-stone-700 dark:text-stone-200 inline-flex items-center justify-center gap-1.5 text-xs font-bold cursor-pointer transition"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span className="md:hidden">Swap Start &amp; Destination</span>
            </button>
          </div>

          {/* Destination Street / Landmark Search */}
          <PlaceSearchInput
            id="coolroute-dest"
            label="Destination"
            placeholder="Search destination (e.g. Guindy, Anna Salai)..."
            value={destPoint}
            localOptions={placeOptions}
            onSelect={setDestPoint}
            isPickingOnMap={pickMode === 'destination'}
            onTogglePickOnMap={() =>
              setPickMode((m) => (m === 'destination' ? 'none' : 'destination'))
            }
          />

          {/* Departure Time Selector */}
          <div className="space-y-1">
            <label htmlFor="coolroute-departure" className="text-[11px] font-bold uppercase text-stone-500 dark:text-stone-400 block">
              Departure Time (Sun Angle)
            </label>
            <input
              id="coolroute-departure"
              type="datetime-local"
              value={departureInput}
              onChange={(e) => {
                setIsAutoDaytimePreview(false);
                setDepartureInput(e.target.value);
              }}
              className="w-full min-h-[42px] rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-3 py-1.5 text-xs font-mono font-bold text-stone-900 dark:text-stone-100"
            />
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => setPresetDeparture(0)}
                className="px-2 py-1 rounded-lg bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
              >
                Now
              </button>
              <button
                type="button"
                onClick={() => setPresetDeparture(60)}
                className="px-2 py-1 rounded-lg bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
              >
                +1h
              </button>
              <button
                type="button"
                onClick={() => setPresetDeparture(180)}
                className="px-2 py-1 rounded-lg bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
              >
                +3h
              </button>
              <button
                type="button"
                onClick={() => setPresetDeparture('noon')}
                className="px-2 py-1 rounded-lg bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
              >
                12:30 IST Sun
              </button>
              <button
                type="button"
                onClick={() => runCoolRouteCalculation()}
                disabled={loading}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-orange-600 text-white text-[10px] font-bold cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                <span>Recalculate</span>
              </button>
            </div>
          </div>
        </div>

        {/* Auto-Switched Daytime Sun Preview Notice when testing at night */}
        {isAutoDaytimePreview && (
          <div className="p-3 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-indigo-950 dark:text-indigo-200">
            <div className="flex items-start gap-2">
              <Moon className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
              <span>
                <span className="font-extrabold">Nighttime in Chennai detected:</span> Auto-previewing
                next midday peak sun (<b>{formatChennaiTimeLabel(initialSun.previewDate)} IST</b>) so
                you can inspect building &amp; tree shade routes.
              </span>
            </div>
            <button
              type="button"
              onClick={() => setPresetDeparture(0)}
              className="px-3 py-1.5 rounded-lg bg-white dark:bg-stone-900 border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 text-[11px] font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition cursor-pointer whitespace-nowrap shrink-0 self-start sm:self-center"
            >
              Use Current Time
            </button>
          </div>
        )}

        {/* Estimation Mode & Reliability Banner */}
        {routeResult && (() => {
          const modeMeta = getEstimationModeMeta(routeResult.reliability.estimationMode);
          const isFallback = routeResult.reliability.estimationMode === 'solar-and-relief-fallback';
          return (
            <div
              className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-start justify-between gap-2 text-xs ${
                isFallback || routeResult.reliabilityWarning
                  ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200'
                  : 'bg-stone-50 dark:bg-stone-950/60 border-stone-200 dark:border-stone-800 text-stone-700 dark:text-stone-300'
              }`}
            >
              <div className="flex items-start gap-2">
                <ShieldAlert
                  className={`w-4 h-4 shrink-0 mt-0.5 ${
                    isFallback || routeResult.reliabilityWarning
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-indigo-600 dark:text-indigo-400'
                  }`}
                />
                <div>
                  <span className="font-extrabold">
                    {isFallback ? 'Fallback Shade Estimate Active: ' : 'Shade Data Basis: '}
                  </span>
                  <span>
                    {routeResult.reliabilityWarning || routeResult.reliability.reason}
                  </span>
                </div>
              </div>
              <span
                className={`px-2 py-0.5 rounded-md border text-[10px] font-extrabold uppercase whitespace-nowrap shrink-0 self-start ${modeMeta.badgeClass}`}
              >
                {modeMeta.label}
              </span>
            </div>
          );
        })()}

        {error && (
          <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-xs text-rose-800 dark:text-rose-200 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => runCoolRouteCalculation()}
              className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-bold cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Embedded Map + Controls */}
      <div className="bg-white dark:bg-stone-900 rounded-2xl p-3 border border-stone-200 dark:border-stone-800 shadow-sm space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Street / Satellite Switch */}
            <div className="inline-flex items-center rounded-xl bg-stone-100 dark:bg-stone-800 p-0.5 border border-stone-200 dark:border-stone-700">
              <button
                type="button"
                onClick={() => setMapStyle('street')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer whitespace-nowrap shrink-0 ${
                  mapStyle === 'street'
                    ? 'bg-orange-600 text-white'
                    : 'text-stone-600 dark:text-stone-300'
                }`}
              >
                <MapIcon className="w-3.5 h-3.5" />
                <span>Street</span>
              </button>
              <button
                type="button"
                onClick={() => setMapStyle('satellite')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer whitespace-nowrap shrink-0 ${
                  mapStyle === 'satellite'
                    ? 'bg-orange-600 text-white'
                    : 'text-stone-600 dark:text-stone-300'
                }`}
              >
                <Satellite className="w-3.5 h-3.5" />
                <span>Satellite</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowShadeOverlay((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold border cursor-pointer ${
                showShadeOverlay
                  ? 'bg-indigo-600 text-white border-indigo-500'
                  : 'bg-stone-50 dark:bg-stone-800 text-stone-700 dark:text-stone-300 border-stone-200 dark:border-stone-700'
              }`}
            >
              <Sun className="w-3.5 h-3.5" />
              <span>Estimated Shade Overlay</span>
            </button>

            <button
              type="button"
              onClick={() => setShowReliefMarkers((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-bold border cursor-pointer ${
                showReliefMarkers
                  ? 'bg-emerald-600 text-white border-emerald-500'
                  : 'bg-stone-50 dark:bg-stone-800 text-stone-700 dark:text-stone-300 border-stone-200 dark:border-stone-700'
              }`}
            >
              <Droplets className="w-3.5 h-3.5" />
              <span>Verified Relief Spots</span>
            </button>
          </div>

          {routeResult && (
            <div className="text-[11px] font-semibold text-stone-600 dark:text-stone-300 tabular-nums">
              {routeResult.sunPosition.solarLabel} · Departure Heat Index{' '}
              <span className="font-black text-orange-600 dark:text-orange-400">
                {routeResult.weatherSummary.heatIndex}°C
              </span>
            </div>
          )}
        </div>

        <div className="relative w-full h-[340px] sm:h-[400px] rounded-2xl overflow-hidden border border-stone-200 dark:border-stone-800">
          <div ref={mapContainerRef} className="w-full h-full z-0" />
          {pickMode !== 'none' && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-xl bg-stone-900/95 text-white text-xs font-bold border border-orange-500 shadow-lg">
              Tap anywhere on map to set {pickMode === 'origin' ? 'Start Point' : 'Destination'}
            </div>
          )}
          {loading && (
            <div className="absolute bottom-3 left-3 z-20 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-stone-900/90 text-white text-xs font-bold shadow-md">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-orange-400" />
              <span>Comparing walking routes &amp; shade...</span>
            </div>
          )}
        </div>

        {/* Route Color Legend */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-600 dark:text-stone-400 px-1">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5 font-bold">
              <span className="w-4 h-1 bg-[#ea580c] inline-block" /> Fastest
            </span>
            <span className="inline-flex items-center gap-1.5 font-bold">
              <span className="w-4 h-1 bg-[#059669] inline-block" /> Most Shaded
            </span>
            <span className="inline-flex items-center gap-1.5 font-bold">
              <span className="w-4 h-1 bg-[#0284c7] inline-block" /> Balanced
            </span>
          </div>
          <span>Click any route line or card below to select</span>
        </div>
      </div>

      {/* 3-Profile Route Comparison Cards */}
      {routeResult && (() => {
        const fastestRoute =
          routeResult.routes.find((r) => r.profile === 'fastest') || routeResult.routes[0];
        return (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {routeResult.routes.map((route) => {
              const isSelected = route.profile === selectedProfile;
              const riskCfg = RISK_CONFIG[route.exposureRisk];
              const accentColor = ROUTE_COLORS[route.profile];
              const modeMeta = getEstimationModeMeta(route.estimationMode);
              const extraMins = fastestRoute
                ? route.walkingMinutes - fastestRoute.walkingMinutes
                : 0;
              const shadeDelta = fastestRoute
                ? route.estimatedShadePct - fastestRoute.estimatedShadePct
                : 0;

              return (
                <div
                  key={route.profile}
                  className={`rounded-2xl p-4 bg-white dark:bg-stone-900 border transition flex flex-col justify-between gap-3 ${
                    isSelected
                      ? 'border-orange-500 ring-2 ring-orange-500/25 shadow-md'
                      : 'border-stone-200 dark:border-stone-800 shadow-xs'
                  }`}
                >
                  <div className="space-y-3">
                    {/* Card Top */}
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: accentColor }}
                          />
                          <h3 className="text-sm font-black text-stone-900 dark:text-white">
                            {lang === 'ta' ? route.titleTa : route.title}
                          </h3>
                        </div>
                        <p className="text-[11px] text-stone-500 dark:text-stone-400 mt-0.5">
                          {route.subtitle}
                        </p>
                      </div>
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase ${riskCfg.badgeClass}`}>
                        {route.exposureRisk}
                      </span>
                    </div>

                    {/* Estimation Source & Path Distinction Strip */}
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                      <span
                        className={`px-1.5 py-0.5 rounded border font-bold ${modeMeta.badgeClass}`}
                      >
                        {modeMeta.shortLabel}
                      </span>
                      {route.profile !== 'fastest' && (
                        <span className="px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 text-stone-600 dark:text-stone-300 font-semibold tabular-nums">
                          {route.isDistinctPath ? 'Alternate Path' : 'Primary Corridor'}
                          {extraMins > 0 ? ` · +${extraMins} min` : ''}
                          {shadeDelta > 0 ? ` · +${shadeDelta}% est. shade` : ''}
                        </span>
                      )}
                    </div>

                    {/* Key Metrics Grid */}
                    <div className="grid grid-cols-2 gap-2 tabular-nums">
                      <div className="p-2.5 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800">
                        <span className="text-[10px] text-stone-500 block">Walking Time &amp; Dist</span>
                        <span className="text-sm font-black text-stone-900 dark:text-white">
                          {route.walkingMinutes} min
                        </span>
                        <span className="text-[11px] text-stone-500 block">
                          {formatDistance(route.distanceMeters)}
                        </span>
                      </div>

                      <div className="p-2.5 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800">
                        <span className="text-[10px] text-stone-500 block">
                          Est. Shade (Not Guaranteed)
                        </span>
                        <span className="text-sm font-black text-emerald-700 dark:text-emerald-400">
                          ~{route.estimatedShadePct}%
                        </span>
                        <span className="text-[11px] text-stone-500 block">
                          Exp HI: {route.exposureHeatIndex}°C
                        </span>
                      </div>
                    </div>

                  {/* Nearby Verified Water & Shade Counts */}
                  <div className="flex items-center justify-between text-xs px-2.5 py-2 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/70 dark:border-stone-800 tabular-nums">
                    <span className="inline-flex items-center gap-1 font-bold text-sky-700 dark:text-sky-400">
                      <Droplets className="w-3.5 h-3.5" />
                      {route.nearbyWaterCount} Water
                    </span>
                    <span className="inline-flex items-center gap-1 font-bold text-emerald-700 dark:text-emerald-400">
                      <Umbrella className="w-3.5 h-3.5" />
                      {route.nearbyShadeCount} Shade
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedStopList((prev) =>
                          prev === route.profile ? null : route.profile
                        )
                      }
                      className="text-[11px] font-bold text-orange-600 dark:text-orange-400 cursor-pointer"
                    >
                      {expandedStopList === route.profile ? 'Hide stops' : 'View stops'}
                    </button>
                  </div>

                  {expandedStopList === route.profile && (
                    <div className="space-y-1 text-[11px] max-h-32 overflow-y-auto pr-1">
                      {route.nearbyReliefPoints.length > 0 ? (
                        route.nearbyReliefPoints.map((rp) => (
                          <div
                            key={`${route.profile}-${rp.id}`}
                            className="flex items-center justify-between gap-2 py-1 border-b border-stone-100 dark:border-stone-800 last:border-0"
                          >
                            <span className="truncate font-semibold text-stone-700 dark:text-stone-300">
                              <MapPin className="w-3 h-3 inline mr-1 text-emerald-600" />
                              {lang === 'ta' && rp.name_ta ? rp.name_ta : rp.name}
                            </span>
                            <span className="text-stone-500 font-mono shrink-0 tabular-nums">
                              {rp.distanceFromRouteMeters}m
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="text-stone-500">No verified relief spots within 280m.</p>
                      )}
                    </div>
                  )}

                  <p className="text-[10px] text-stone-500 dark:text-stone-400 leading-snug">
                    {route.shadeBasisNote}
                  </p>
                </div>

                {/* Action Row */}
                <div className="flex items-center gap-2 pt-2 border-t border-stone-100 dark:border-stone-800">
                  <button
                    type="button"
                    onClick={() => setSelectedProfile(route.profile)}
                    className={`flex-1 min-h-[40px] px-3 py-2 rounded-xl text-xs font-extrabold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                      isSelected
                        ? 'bg-emerald-600 text-white'
                        : 'bg-stone-900 dark:bg-stone-800 text-white hover:bg-stone-800'
                    }`}
                  >
                    {isSelected ? <CheckCircle2 className="w-4 h-4" /> : <Navigation className="w-3.5 h-3.5" />}
                    <span>{isSelected ? 'Selected Route' : 'Select Route'}</span>
                  </button>

                  <a
                    href={`https://www.google.com/maps/dir/?api=1&origin=${originPoint.lat},${originPoint.lng}&destination=${destPoint.lat},${destPoint.lng}&travelmode=walking`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[40px] px-3 py-2 rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 text-stone-700 dark:text-stone-200 hover:bg-stone-100 text-xs font-bold inline-flex items-center gap-1"
                    title="Open walking route in Google Maps"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Maps</span>
                  </a>
                </div>
              </div>
            );
          })}
          </div>
        );
      })()}

      {/* Selected Route Summary & Honest Estimate Disclaimer */}
      {routeResult && activeRoute && (
        <div className="bg-stone-50 dark:bg-stone-900/80 rounded-2xl p-3.5 border border-stone-200 dark:border-stone-800 flex items-start gap-2.5 text-xs text-stone-600 dark:text-stone-300">
          <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-bold text-stone-900 dark:text-stone-100">
              Active Choice: {activeRoute.title} ({activeRoute.walkingMinutes} min ·{' '}
              {formatDistance(activeRoute.distanceMeters)} · ~{activeRoute.estimatedShadePct}% estimated shade)
            </div>
            <p className="text-[11px] text-stone-500 dark:text-stone-400">
              {routeResult.shadeDisclaimer} Verified GCC water/shade shelters along the route remain
              your most dependable cooling stops.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
