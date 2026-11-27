import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import {
  ZoneDetail,
  ReliefPoint,
  Language,
  MapBaseStyle,
  ShadePredictionResponse,
} from '../../types';
import {
  PRIMARY_AREAS,
  subscribeWeatherStatus,
  getWeatherStatus,
  WeatherServiceStatus,
} from '../../services/weather';
import { PointWeatherReading } from '../../services/location';
import { fetchShadePrediction } from '../../services/intelligenceApi';
import { attachBaseLayer } from '../../utils/mapTiles';
import {
  getInitialSunDepartureState,
  getNextChennaiMiddaySunDate,
  toLocalDateTimeInputValue,
} from '../../utils/sunPreview';
import { RISK_CONFIG } from '../../utils/heatIndex';
import {
  Layers,
  Locate,
  ShieldCheck,
  Wifi,
  WifiOff,
  AlertTriangle,
  Thermometer,
  Droplets,
  Clock,
  X,
  Map as MapIcon,
  Satellite,
  Sun,
  Route,
  RefreshCw,
} from 'lucide-react';

interface Props {
  zones: ZoneDetail[];
  reliefPoints: ReliefPoint[];
  selectedZoneId: string;
  onSelectZone: (id: string) => void;
  lang: Language;
  userCoords: { lat: number; lng: number } | null;
  locationWeather: PointWeatherReading | null;
  locationWeatherStatus: {
    isLive: boolean;
    updatedTimeStr: string;
    error: string | null;
  } | null;
  onLocateMe: () => void;
  isLocating: boolean;
  locationMessage: { type: 'error' | 'info'; text: string } | null;
  onNavigateTab: (tab: 'nearby' | 'coolroute') => void;
}

const PRIMARY_AREA_IDS = new Set<string>(PRIMARY_AREAS.map((a) => a.id));

function getHeatColor(hi: number): string {
  if (hi < 32) return '#22c55e'; // Green LOW
  if (hi < 36) return '#eab308'; // Yellow MODERATE
  if (hi <= 41) return '#f97316'; // Orange HIGH
  return '#ef4444'; // Red EXTREME
}

export const WorkerMap: React.FC<Props> = ({
  zones,
  reliefPoints,
  selectedZoneId,
  onSelectZone,
  lang,
  userCoords,
  locationWeather,
  locationWeatherStatus,
  onLocateMe,
  isLocating,
  locationMessage,
  onNavigateTab,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const baseTileLayerRef = useRef<L.Layer | null>(null);
  const shadeGroupRef = useRef<L.LayerGroup | null>(null);
  const layersGroupRef = useRef<L.LayerGroup | null>(null);

  const [mapStyle, setMapStyle] = useState<MapBaseStyle>('street');
  const [showReliefPoints, setShowReliefPoints] = useState(true);
  // Keep 5 area circles available as a toggle ("Show city areas"), off by default
  const [showCityAreas, setShowCityAreas] = useState(false);
  const [showShadeOverlay, setShowShadeOverlay] = useState(false);
  const initialSun = useMemo(() => getInitialSunDepartureState(), []);
  const [departureInput, setDepartureInput] = useState<string>(initialSun.departureInput);
  const [isAutoDaytimePreview, setIsAutoDaytimePreview] = useState<boolean>(
    initialSun.isAutoDaytimePreview
  );

  const [shadeData, setShadeData] = useState<ShadePredictionResponse | null>(null);
  const [shadeLoading, setShadeLoading] = useState(false);
  const [shadeError, setShadeError] = useState<string | null>(null);

  const [selectedZoneInfo, setSelectedZoneInfo] = useState<ZoneDetail | null>(null);
  const [showUserLocationCard, setShowUserLocationCard] = useState(false);

  const [weatherStatus, setWeatherStatus] = useState<WeatherServiceStatus>(getWeatherStatus);

  useEffect(() => {
    return subscribeWeatherStatus(setWeatherStatus);
  }, []);

  const activeFocusCoords = useMemo(() => {
    if (userCoords) return userCoords;
    const z = zones.find((item) => item.id === selectedZoneId) || zones[0];
    return z ? { lat: z.lat, lng: z.lng } : { lat: 13.06, lng: 80.22 };
  }, [userCoords, zones, selectedZoneId]);

  // Initialize Leaflet map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: userCoords ? [userCoords.lat, userCoords.lng] : [13.06, 80.22],
      zoom: userCoords ? 15 : 12,
      minZoom: 10,
      maxZoom: 19,
      zoomControl: true,
    });

    baseTileLayerRef.current = attachBaseLayer(map, null, 'street');

    const shadeGroup = L.layerGroup().addTo(map);
    shadeGroupRef.current = shadeGroup;

    const layerGroup = L.layerGroup().addTo(map);
    layersGroupRef.current = layerGroup;

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      baseTileLayerRef.current = null;
      shadeGroupRef.current = null;
      layersGroupRef.current = null;
    };
  }, []);

  // Switch Street <-> Hybrid Satellite tile layer seamlessly while keeping all overlays and markers intact
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    baseTileLayerRef.current = attachBaseLayer(map, baseTileLayerRef.current, mapStyle);
  }, [mapStyle]);

  // Fetch Shade Prediction overlay whenever enabled or departure time / focus center changes
  useEffect(() => {
    if (!showShadeOverlay) {
      setShadeError(null);
      return;
    }

    const controller = new AbortController();
    setShadeLoading(true);
    setShadeError(null);

    const parsedDate = new Date(departureInput);
    const iso = Number.isNaN(parsedDate.getTime())
      ? new Date().toISOString()
      : parsedDate.toISOString();

    fetchShadePrediction({
      lat: activeFocusCoords.lat,
      lng: activeFocusCoords.lng,
      radiusMeters: 420,
      departureTimeIso: iso,
      signal: controller.signal,
    })
      .then((res) => {
        setShadeData(res);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setShadeError(err?.message || 'Unable to compute shade overlay.');
      })
      .finally(() => {
        setShadeLoading(false);
      });

    return () => controller.abort();
  }, [showShadeOverlay, departureInput, activeFocusCoords.lat, activeFocusCoords.lng]);

  // Render Shade Prediction polygons, tree canopies, and shaded vs sunny road segments
  useEffect(() => {
    const map = mapInstanceRef.current;
    const shadeGroup = shadeGroupRef.current;
    if (!map || !shadeGroup) return;

    shadeGroup.clearLayers();
    if (!showShadeOverlay || !shadeData) return;

    // 1. Estimated building shadows (distinct translucent slate/indigo dashed polygons)
    shadeData.buildingShadows.forEach((poly) => {
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
        fillOpacity: poly.source === 'footprint-inferred' ? 0.34 : 0.42,
        weight: 1,
        dashArray: '3 3',
      });
      polygon.bindPopup(
        `<div style="font-family:sans-serif;min-width:170px;">
          <div style="font-size:10px;font-weight:800;color:#4338ca;text-transform:uppercase;">Estimated Building Shadow</div>
          <div style="font-size:12px;margin-top:3px;">Height source: <b>${sourceLabel}</b> (~${poly.heightMeters}m)</div>
          <div style="font-size:10px;color:#57534e;margin-top:3px;">Calculated from SunCalc solar geometry — estimate only.</div>
        </div>`
      );
      shadeGroup.addLayer(polygon);
    });

    // 2. OSM Tree, Park, Forest/Meadow & Verified Relief Shade canopies
    shadeData.treeCanopies.forEach((tree) => {
      const isRelief = tree.source === 'relief-shade';
      const isForestOrMeadow = tree.source === 'osm-forest' || tree.source === 'osm-meadow';
      const stroke = isRelief ? '#0f766e' : isForestOrMeadow ? '#166534' : '#15803d';
      const fill = isRelief ? '#14b8a6' : isForestOrMeadow ? '#16a34a' : '#22c55e';
      const sourceLabel =
        tree.source === 'relief-shade'
          ? 'Verified Relief Shade Buffer'
          : tree.source === 'osm-forest'
            ? 'OSM Forest / Wood'
            : tree.source === 'osm-meadow'
              ? 'OSM Meadow / Green Zone'
              : tree.source === 'osm-park'
                ? 'OSM Park / Garden'
                : 'OSM Tree';
      const canopy = L.circle([tree.lat, tree.lng], {
        radius: tree.radiusMeters,
        color: stroke,
        fillColor: fill,
        fillOpacity: isRelief ? 0.22 : 0.28,
        weight: 1,
        dashArray: '2 4',
      });
      canopy.bindPopup(
        `<div style="font-family:sans-serif;min-width:165px;">
          <div style="font-size:10px;font-weight:800;color:${stroke};text-transform:uppercase;">Estimated Canopy (${sourceLabel})</div>
          <div style="font-size:11px;color:#44403c;margin-top:2px;">Mapped shade radius ~${tree.radiusMeters}m (estimate)</div>
        </div>`
      );
      shadeGroup.addLayer(canopy);
    });

    // 3. Road segment shade estimates (shaded = teal, partial = amber, sunny = red-orange)
    shadeData.roadSegments.forEach((seg) => {
      const segColor =
        seg.classification === 'shaded'
          ? '#0f766e'
          : seg.classification === 'partial'
            ? '#d97706'
            : '#ef4444';
      const polyline = L.polyline(seg.coordinates, {
        color: segColor,
        weight: seg.classification === 'shaded' ? 5 : 3.5,
        opacity: 0.85,
      });
      polyline.bindPopup(
        `<div style="font-family:sans-serif;min-width:180px;">
          <div style="font-size:10px;font-weight:800;color:${segColor};text-transform:uppercase;">
            Estimated Road Shade: ${seg.classification.toUpperCase()} (${Math.round(seg.shadeScore * 100)}%)
          </div>
          <div style="font-size:11px;color:#44403c;margin-top:3px;">${seg.basis}</div>
          <div style="font-size:10px;color:#78716c;margin-top:3px;">Estimate based on solar angle & available OSM tags, not guaranteed.</div>
        </div>`
      );
      shadeGroup.addLayer(polyline);
    });
  }, [showShadeOverlay, shadeData]);

  // Render single 500m user circle + center heat index label + "You are here" dot, optional 5 city area circles, and relief points
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = layersGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    // 1. Optional 5 City Area Circles ("Show city areas" toggle, off by default)
    if (showCityAreas) {
      const fiveAreas = zones.filter((z) => PRIMARY_AREA_IDS.has(z.id));
      fiveAreas.forEach((zone) => {
        const hi = zone.current_reading.heat_index;
        const circleColor = getHeatColor(hi);
        const isSelected = zone.id === selectedZoneId;

        const circle = L.circle([zone.lat, zone.lng], {
          color: circleColor,
          fillColor: circleColor,
          fillOpacity: isSelected ? 0.38 : 0.25,
          weight: isSelected ? 3 : 2,
          radius: 1400,
        });

        const markerHtml = `
          <div style="
            background-color: ${circleColor};
            color: white;
            font-weight: 900;
            font-size: 11px;
            border-radius: 9999px;
            padding: 3px 8px;
            box-shadow: 0 3px 6px rgba(0, 0, 0, 0.35);
            border: 2px solid white;
            text-align: center;
            white-space: nowrap;
            cursor: pointer;
          ">
            ${zone.name}: ${Math.round(hi)}°C
          </div>
        `;

        const zoneIcon = L.divIcon({
          className: 'custom-heat-pin',
          html: markerHtml,
          iconSize: [94, 24],
          iconAnchor: [47, 12],
        });

        const marker = L.marker([zone.lat, zone.lng], { icon: zoneIcon });

        const handleClick = () => {
          onSelectZone(zone.id);
          setShowUserLocationCard(false);
          setSelectedZoneInfo(zone);
        };

        circle.on('click', handleClick);
        marker.on('click', handleClick);

        layerGroup.addLayer(circle);
        layerGroup.addLayer(marker);
      });
    }

    // 2. ONE 500m circle at the user's exact position + center Heat Index label + "You are here" marker
    if (userCoords && locationWeather) {
      const circleColor = getHeatColor(locationWeather.heat_index);
      const roundedHI = Math.round(locationWeather.heat_index);

      const userCircle = L.circle([userCoords.lat, userCoords.lng], {
        color: circleColor,
        fillColor: circleColor,
        fillOpacity: 0.35,
        weight: 3,
        radius: 500,
      });

      const handleTapCircle = () => {
        setSelectedZoneInfo(null);
        setShowUserLocationCard(true);
      };

      userCircle.on('click', handleTapCircle);
      layerGroup.addLayer(userCircle);

      const centerOverlayHtml = `
        <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%);cursor:pointer;">
          <div style="
            background-color: #1c1917;
            color: #ffffff;
            font-size: 10px;
            font-weight: 800;
            padding: 2px 7px;
            border-radius: 9999px;
            border: 1.5px solid #ffffff;
            box-shadow: 0 2px 6px rgba(0,0,0,0.4);
            white-space: nowrap;
            margin-bottom: 4px;
          ">
            ${lang === 'ta' ? 'நீங்கள் இங்கே' : 'You are here'}
          </div>
          <div style="
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background-color: #2563eb;
            border: 2px solid #ffffff;
            box-shadow: 0 0 8px rgba(37,99,235,0.85);
            margin-bottom: 4px;
          "></div>
          <div style="
            background-color: ${circleColor};
            color: #ffffff;
            font-size: 13px;
            font-weight: 900;
            padding: 2px 9px;
            border-radius: 9999px;
            border: 2px solid #ffffff;
            box-shadow: 0 2px 8px rgba(0,0,0,0.35);
            white-space: nowrap;
          ">
            ${roundedHI}°
          </div>
        </div>
      `;

      const centerIcon = L.divIcon({
        className: 'user-center-heat-marker',
        html: centerOverlayHtml,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const centerMarker = L.marker([userCoords.lat, userCoords.lng], {
        icon: centerIcon,
        zIndexOffset: 1000,
      });
      centerMarker.on('click', handleTapCircle);
      layerGroup.addLayer(centerMarker);
    } else if (userCoords) {
      const dotIcon = L.divIcon({
        className: 'you-are-here-dot',
        html: `
          <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%);">
            <div style="background:#1c1917;color:white;font-size:10px;font-weight:800;padding:2px 7px;border-radius:9999px;border:1.5px solid white;margin-bottom:3px;white-space:nowrap;">
              ${lang === 'ta' ? 'நீங்கள் இங்கே' : 'You are here'}
            </div>
            <div style="width:10px;height:10px;border-radius:50%;background:#2563eb;border:2px solid white;box-shadow:0 0 8px #2563eb;"></div>
          </div>
        `,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      layerGroup.addLayer(L.marker([userCoords.lat, userCoords.lng], { icon: dotIcon }));
    }

    // 3. Draw Verified Relief Points (Water, Shade, Cooling)
    if (showReliefPoints) {
      reliefPoints.forEach((rp) => {
        let iconSymbol = '💧';
        let bgColor = '#0284c7';
        if (rp.type === 'shade') {
          iconSymbol = '☂️';
          bgColor = '#16a34a';
        } else if (rp.type === 'cooling') {
          iconSymbol = '❄️';
          bgColor = '#7c3aed';
        }

        const pointIconHtml = `
          <div style="
            background-color: ${bgColor};
            color: white;
            font-size: 13px;
            width: 26px;
            height: 26px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.4);
            border: 2px solid white;
            cursor: pointer;
          ">
            ${iconSymbol}
          </div>
        `;

        const pointIcon = L.divIcon({
          className: 'relief-pin',
          html: pointIconHtml,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });

        const pointMarker = L.marker([rp.lat, rp.lng], { icon: pointIcon });

        const popupContent = `
          <div style="font-family: sans-serif; min-width: 190px;">
            <div style="font-size:10px;font-weight:800;color:#15803d;text-transform:uppercase;margin-bottom:2px;">
              ${rp.verified ? 'Verified Relief Point' : 'Community Relief Point'}
            </div>
            <b style="font-size: 13px; color: #1c1917;">${lang === 'ta' ? rp.name_ta : rp.name}</b>
            <p style="font-size: 11px; color: #57534e; margin: 3px 0 6px 0;">${lang === 'ta' ? rp.address_ta : rp.address}</p>
            <div style="display: flex; gap: 4px; margin-bottom: 6px;">
              <span style="background: #e0f2fe; color: #0369a1; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold;">
                ${rp.type.toUpperCase()}
              </span>
              <span style="background: #f1f5f9; color: #334155; padding: 2px 6px; border-radius: 4px; font-size: 10px;">
                Cap: ${rp.capacity}
              </span>
            </div>
            <a 
              href="https://www.google.com/maps/dir/?api=1&destination=${rp.lat},${rp.lng}" 
              target="_blank" 
              rel="noopener noreferrer"
              style="display: block; text-align: center; background: #ea580c; color: white; padding: 5px 8px; border-radius: 6px; font-size: 11px; font-weight: bold; text-decoration: none;"
            >
              Directions ➔
            </a>
          </div>
        `;
        pointMarker.bindPopup(popupContent);
        layerGroup.addLayer(pointMarker);
      });
    }
  }, [zones, reliefPoints, selectedZoneId, showReliefPoints, showCityAreas, userCoords, locationWeather, lang, onSelectZone]);

  // Center map appropriately when userCoords, shade overlay focus, or city area changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    if (userCoords) {
      map.setView([userCoords.lat, userCoords.lng], showShadeOverlay ? 16 : 15, { animate: true });
      setSelectedZoneInfo(null);
      return;
    }

    setShowUserLocationCard(false);
    if (showShadeOverlay) {
      const zone = zones.find((z) => z.id === selectedZoneId);
      if (zone) {
        map.setView([zone.lat, zone.lng], 16, { animate: true });
      }
    } else if (showCityAreas) {
      const zone = zones.find((z) => z.id === selectedZoneId);
      if (zone) {
        map.setView([zone.lat, zone.lng], 12, { animate: true });
      }
    }
  }, [userCoords, selectedZoneId, zones, showCityAreas, showShadeOverlay]);

  const effectiveIsLive =
    userCoords && locationWeatherStatus
      ? locationWeatherStatus.isLive
      : weatherStatus.isLive;
  const effectiveBadgeText =
    userCoords && locationWeatherStatus
      ? locationWeatherStatus.isLive
        ? `Live • ${locationWeatherStatus.updatedTimeStr}`
        : 'Offline'
      : weatherStatus.isLive
        ? weatherStatus.badge || 'Live'
        : 'Offline';

  const userSaferHours = locationWeather
    ? locationWeather.hourly
        .filter((h) => h.hour_num >= 6 && h.hour_num <= 22 && h.heat_index < 33)
        .map((h) => h.hour)
    : [];

  const userRiskConfig = locationWeather ? RISK_CONFIG[locationWeather.risk] : null;

  const setPresetTime = (offsetMinutes: number | 'noon') => {
    setIsAutoDaytimePreview(false);
    if (offsetMinutes === 'noon') {
      setDepartureInput(toLocalDateTimeInputValue(getNextChennaiMiddaySunDate(new Date())));
      return;
    }
    const base = new Date();
    base.setMinutes(base.getMinutes() + offsetMinutes);
    setDepartureInput(toLocalDateTimeInputValue(base));
  };

  return (
    <div className="relative w-full h-[calc(100vh-120px)] sm:h-[calc(100vh-130px)] bg-stone-100 dark:bg-stone-900 pb-16">
      {/* Map Element */}
      <div ref={mapContainerRef} className="w-full h-full z-0" />

      {/* Top-Right Controls: Live Badge, Street/Satellite Toggle, Shade Prediction, City Areas, Relief Spots & GPS */}
      <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-1.5 max-w-[215px]">
        {/* Live / Offline Badge */}
        <div
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-extrabold shadow-md border backdrop-blur-md ${
            effectiveIsLive
              ? 'bg-emerald-950/90 text-emerald-300 border-emerald-500/50'
              : 'bg-amber-950/90 text-amber-300 border-amber-500/50'
          }`}
        >
          {effectiveIsLive ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          <span>{effectiveBadgeText}</span>
        </div>

        {/* Street | Satellite Base Map Toggle */}
        <div className="inline-flex items-center rounded-xl bg-white/95 dark:bg-stone-900/95 p-1 shadow-md border border-stone-200 dark:border-stone-700 backdrop-blur-md">
          <button
            type="button"
            onClick={() => setMapStyle('street')}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
              mapStyle === 'street'
                ? 'bg-orange-600 text-white shadow-xs'
                : 'text-stone-700 dark:text-stone-300'
            }`}
          >
            <MapIcon className="w-3.5 h-3.5" />
            <span>{lang === 'ta' ? 'தெரு' : 'Street'}</span>
          </button>
          <button
            type="button"
            onClick={() => setMapStyle('satellite')}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
              mapStyle === 'satellite'
                ? 'bg-orange-600 text-white shadow-xs'
                : 'text-stone-700 dark:text-stone-300'
            }`}
          >
            <Satellite className="w-3.5 h-3.5" />
            <span>{lang === 'ta' ? 'செயற்கைக்கோள்' : 'Satellite'}</span>
          </button>
        </div>

        {/* Shade Prediction Overlay Toggle */}
        <button
          type="button"
          onClick={() => setShowShadeOverlay((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold shadow-md transition cursor-pointer backdrop-blur-md whitespace-nowrap ${
            showShadeOverlay
              ? 'bg-indigo-600 text-white border border-indigo-400'
              : 'bg-white/95 dark:bg-stone-900/95 text-stone-700 dark:text-stone-200 border border-stone-200 dark:border-stone-700'
          }`}
        >
          <Sun className="w-4 h-4 shrink-0" />
          <span>{lang === 'ta' ? 'நிழல் கணிப்பு' : 'Shade Estimate'}</span>
        </button>

        {/* Toggle: Show city areas (5 area circles, OFF by default) */}
        <button
          type="button"
          onClick={() => setShowCityAreas((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold shadow-md transition cursor-pointer backdrop-blur-md whitespace-nowrap ${
            showCityAreas
              ? 'bg-orange-600 text-white border border-orange-500'
              : 'bg-white/95 dark:bg-stone-900/95 text-stone-700 dark:text-stone-200 border border-stone-200 dark:border-stone-700'
          }`}
        >
          <Layers className="w-4 h-4 shrink-0" />
          <span>{lang === 'ta' ? 'நகரப் பகுதிகளைக் காட்டு' : 'Show city areas'}</span>
        </button>

        {/* Toggle Relief Points Overlay */}
        <button
          type="button"
          onClick={() => setShowReliefPoints((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold shadow-md transition cursor-pointer backdrop-blur-md whitespace-nowrap ${
            showReliefPoints
              ? 'bg-stone-900 text-white border border-stone-700'
              : 'bg-white/95 dark:bg-stone-900/95 text-stone-700 dark:text-stone-200 border border-stone-200 dark:border-stone-700'
          }`}
        >
          <Layers className="w-4 h-4 text-orange-400 shrink-0" />
          <span>{showReliefPoints ? 'Hide Relief Spots' : 'Show Relief Spots'}</span>
        </button>

        {/* Use my location */}
        <button
          type="button"
          onClick={onLocateMe}
          disabled={isLocating}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/95 dark:bg-stone-900/95 text-stone-800 dark:text-stone-100 text-xs font-bold shadow-md border border-stone-200 dark:border-stone-800 hover:bg-stone-50 transition cursor-pointer disabled:opacity-50 whitespace-nowrap"
          title="Use my location"
        >
          <Locate className={`w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0 ${isLocating ? 'animate-spin' : ''}`} />
          <span>
            {isLocating
              ? lang === 'ta' ? 'தேடுகிறது...' : 'Locating...'
              : lang === 'ta' ? 'என் இருப்பிடம்' : 'Use my location'}
          </span>
        </button>

        {/* Launch CoolRoute */}
        <button
          type="button"
          onClick={() => onNavigateTab('coolroute')}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-md transition cursor-pointer whitespace-nowrap"
        >
          <Route className="w-4 h-4 shrink-0" />
          <span>{lang === 'ta' ? 'குளிர் வழி (CoolRoute)' : 'Plan CoolRoute'}</span>
        </button>
      </div>

      {/* Top-Left Legend + Shade Departure Time Controls */}
      <div className="absolute top-3 left-3 z-10 bg-white/95 dark:bg-stone-900/95 backdrop-blur-md p-2.5 sm:p-3 rounded-2xl shadow-lg border border-stone-200 dark:border-stone-800 text-[11px] max-w-[250px] space-y-2">
        <div>
          <span className="font-extrabold text-stone-900 dark:text-stone-100 block mb-1">
            {lang === 'ta' ? 'வெப்பக் குறியீடு (அளவீடு)' : 'Heat Index & Verified Spots'}
          </span>
          <div className="grid grid-cols-3 gap-1 text-[10px] text-stone-700 dark:text-stone-300 tabular-nums">
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-[#22c55e] shrink-0" />
              <span>&lt;33°</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b] shrink-0" />
              <span>33–41°</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444] shrink-0" />
              <span>&gt;41°</span>
            </div>
          </div>
          <div className="mt-1 text-[10px] text-stone-500 dark:text-stone-400">
            ☂️ Shade · 💧 Water · ❄️ Cooling (GCC Static)
          </div>
        </div>

        {/* Shade Prediction Controls & Honest Reliability Readout */}
        {showShadeOverlay && (
          <div className="pt-2 border-t border-stone-200 dark:border-stone-800 space-y-2">
            <div className="flex items-center justify-between gap-1">
              <span className="font-extrabold text-indigo-700 dark:text-indigo-300">
                Estimated Shade (SunCalc)
              </span>
              {shadeLoading && <RefreshCw className="w-3 h-3 animate-spin text-indigo-500" />}
            </div>

            <div className="space-y-1">
              <label
                htmlFor="worker-map-departure"
                className="text-[10px] font-bold text-stone-500 dark:text-stone-400 block"
              >
                Departure Time
              </label>
              <input
                id="worker-map-departure"
                type="datetime-local"
                value={departureInput}
                onChange={(e) => {
                  setIsAutoDaytimePreview(false);
                  setDepartureInput(e.target.value);
                }}
                className="w-full rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 px-2 py-1 text-[11px] font-mono text-stone-800 dark:text-stone-100"
              />
              {isAutoDaytimePreview && (
                <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800 text-[10px] text-indigo-800 dark:text-indigo-200 flex items-center justify-between gap-1">
                  <span>Nighttime · previewing 12:30 IST sun</span>
                  <button
                    type="button"
                    onClick={() => setPresetTime(0)}
                    className="underline font-bold cursor-pointer shrink-0"
                  >
                    Now
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setPresetTime(0)}
                  className="px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
                >
                  Now
                </button>
                <button
                  type="button"
                  onClick={() => setPresetTime(60)}
                  className="px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
                >
                  +1h
                </button>
                <button
                  type="button"
                  onClick={() => setPresetTime(180)}
                  className="px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
                >
                  +3h
                </button>
                <button
                  type="button"
                  onClick={() => setPresetTime('noon')}
                  className="px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-[10px] font-bold text-stone-700 dark:text-stone-300 cursor-pointer"
                >
                  12:30 Sun
                </button>
              </div>
            </div>

            {shadeData && (
              <div className="space-y-1.5 text-[10px]">
                <div className="text-stone-700 dark:text-stone-300 font-semibold tabular-nums">
                  {shadeData.sunPosition.solarLabel}
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-1 bg-[#0f766e] inline-block" /> Shaded
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-1 bg-[#d97706] inline-block" /> Partial
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-1 bg-[#ef4444] inline-block" /> Sunny
                  </span>
                </div>
                <div
                  className={`p-1.5 rounded-lg border text-[10px] leading-snug ${
                    shadeData.reliability.level === 'low' ||
                    shadeData.reliability.estimationMode === 'solar-and-relief-fallback'
                      ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200'
                      : 'bg-stone-50 dark:bg-stone-950 border-stone-200 dark:border-stone-800 text-stone-600 dark:text-stone-300'
                  }`}
                >
                  <span className="font-extrabold uppercase block">
                    {shadeData.reliability.estimationMode === 'measured-osm'
                      ? 'Estimated (OSM Heights + Canopy)'
                      : shadeData.reliability.estimationMode === 'inferred-footprint-and-canopy'
                        ? 'Estimated (Inferred 8–12m + Relief)'
                        : 'Fallback (Sun Angle + Relief)'}{' '}
                    · {shadeData.reliability.level}
                  </span>
                  <span className="block mt-0.5">{shadeData.reliability.reason}</span>
                </div>
              </div>
            )}

            {shadeError && (
              <div className="text-[10px] text-rose-600 dark:text-rose-400 font-semibold">
                {shadeError}
              </div>
            )}
          </div>
        )}

        {userCoords && (
          <div className="pt-1.5 border-t border-stone-200 dark:border-stone-800 text-[10px] font-bold text-blue-600 dark:text-blue-400">
            {lang === 'ta'
              ? '500 மீ வட்டம் — விவரங்களுக்கு வட்டத்தைத் தட்டவும்'
              : '500 m zone — tap circle for details'}
          </div>
        )}

        {locationMessage && (
          <div className="pt-1.5 border-t border-stone-200 dark:border-stone-800 flex items-start gap-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{locationMessage.text}</span>
          </div>
        )}
      </div>

      {/* Bottom Floating Card when User Taps their 500m Circle */}
      {showUserLocationCard && userCoords && locationWeather && userRiskConfig && (
        <div className="absolute bottom-16 sm:bottom-18 left-3 right-3 sm:left-auto sm:right-6 sm:w-96 z-20 bg-white dark:bg-stone-900 p-4 rounded-2xl shadow-2xl border border-stone-200 dark:border-stone-800 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
                  {lang === 'ta' ? 'உங்கள் இருப்பிடம்' : 'Your location'} · 500 m
                </span>
                <span className={`px-2 py-0.5 rounded-md text-[10px] font-black uppercase ${userRiskConfig.badgeClass}`}>
                  {lang === 'ta' ? userRiskConfig.labelTa : userRiskConfig.labelEn}
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-1.5 tabular-nums">
                <span className="text-3xl font-black text-stone-900 dark:text-white">
                  {locationWeather.heat_index}°C
                </span>
                <span className="text-xs font-semibold text-stone-500">
                  {lang === 'ta' ? 'உணரப்படும் வெப்பம் (Feels like)' : 'Heat index (Feels like)'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowUserLocationCard(false)}
              className="p-1 rounded-lg text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 cursor-pointer"
              aria-label="Close card"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800">
              <Thermometer className="w-4 h-4 text-orange-500 shrink-0" />
              <div className="tabular-nums">
                <span className="text-[10px] text-stone-500 block">
                  {lang === 'ta' ? 'காற்று வெப்பம்' : 'Air temperature'}
                </span>
                <span className="text-sm font-black text-stone-900 dark:text-white">
                  {locationWeather.temp}°C
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200/80 dark:border-stone-800">
              <Droplets className="w-4 h-4 text-cyan-500 shrink-0" />
              <div className="tabular-nums">
                <span className="text-[10px] text-stone-500 block">
                  {lang === 'ta' ? 'ஈரப்பதம்' : 'Humidity'}
                </span>
                <span className="text-sm font-black text-stone-900 dark:text-white">
                  {locationWeather.humidity}%
                </span>
              </div>
            </div>
          </div>

          {/* Safer Hours */}
          <div className="pt-2 border-t border-stone-100 dark:border-stone-800">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-400 mb-1.5">
              <Clock className="w-3.5 h-3.5" />
              <span>{lang === 'ta' ? 'பாதுகாப்பான வேலை நேரம்' : 'Safer hours (06:00–22:00)'}</span>
            </div>
            <div className="flex flex-wrap gap-1 tabular-nums">
              {userSaferHours.length > 0 ? (
                userSaferHours.slice(0, 8).map((sh) => (
                  <span
                    key={sh}
                    className="px-1.5 py-0.5 rounded bg-emerald-600 text-white font-mono text-[10px] font-bold"
                  >
                    {sh}
                  </span>
                ))
              ) : (
                <span className="text-xs text-stone-500">
                  {lang === 'ta' ? 'அதிகாலை 06:00–08:00 மட்டும்' : 'Early morning only'}
                </span>
              )}
              {userSaferHours.length > 8 && (
                <span className="text-[10px] text-stone-500 self-center ml-1">
                  +{userSaferHours.length - 8} more
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom Floating Info Sheet for Selected City Area (when "Show city areas" is toggled ON) */}
      {selectedZoneInfo && !showUserLocationCard && (
        <div className="absolute bottom-16 sm:bottom-18 left-3 right-3 sm:left-auto sm:right-6 sm:w-96 z-20 bg-white dark:bg-stone-900 p-4 rounded-2xl shadow-2xl border border-stone-200 dark:border-stone-800">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-[10px] font-bold text-orange-600 dark:text-orange-400 uppercase tracking-wider">
                Ward {selectedZoneInfo.ward_no} · {selectedZoneInfo.id.toUpperCase()}
              </span>
              <h2 className="text-base font-black text-stone-900 dark:text-stone-100">
                {lang === 'ta' ? selectedZoneInfo.name_ta : selectedZoneInfo.name}
              </h2>
            </div>
            <div className="text-right tabular-nums">
              <span className="text-2xl font-black text-orange-600 dark:text-orange-400">
                {selectedZoneInfo.current_reading.heat_index}°C
              </span>
              <span className="text-[10px] block font-semibold text-stone-500">
                {lang === 'ta' ? 'உணரப்படும் வெப்பம்' : 'Feels like'}
              </span>
            </div>
          </div>

          <p className="text-xs text-stone-600 dark:text-stone-300 mt-1 line-clamp-2">
            {lang === 'ta' ? selectedZoneInfo.description_ta : selectedZoneInfo.description}
          </p>

          <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-stone-100 dark:border-stone-800 text-xs">
            <div className="flex items-center gap-2 text-stone-600 dark:text-stone-400">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>{selectedZoneInfo.relief_points_count} Relief Points</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onNavigateTab('coolroute')}
                className="px-2.5 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 transition cursor-pointer"
              >
                CoolRoute
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('nearby')}
                className="px-2.5 py-1.5 rounded-lg bg-orange-600 text-white text-xs font-bold hover:bg-orange-700 transition cursor-pointer"
              >
                View Points ➔
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
