import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { ReliefPoint, Language, MapBaseStyle } from '../../types';
import { WeatherServiceStatus } from '../../../services/weather';
import { attachBaseLayer } from '../../utils/mapTiles';
import { Layers, Wifi, WifiOff, Flame, Umbrella, Droplets, Snowflake, Map as MapIcon, Satellite } from 'lucide-react';

export interface AuthorityHotspotArea {
  id: string;
  name: string;
  name_ta: string;
  ward_no: number;
  lat: number;
  lng: number;
  temp: number;
  humidity: number;
  heatIndex: number;
  extremeHoursToday: number;
}

interface Props {
  areas: AuthorityHotspotArea[];
  reliefPoints: ReliefPoint[];
  weatherStatus: WeatherServiceStatus;
  lang: Language;
}

function getHeatColor(hi: number): string {
  if (hi < 32) return '#22c55e'; // green LOW
  if (hi < 36) return '#eab308'; // yellow MODERATE
  if (hi <= 41) return '#f97316'; // orange HIGH
  return '#ef4444'; // red EXTREME
}

function getRiskTag(hi: number, lang: Language): { label: string; cls: string } {
  if (hi < 32) {
    return {
      label: lang === 'ta' ? 'குறைவு (LOW)' : 'LOW (<32°C)',
      cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    };
  }
  if (hi < 36) {
    return {
      label: lang === 'ta' ? 'மிதமான (MODERATE)' : 'MODERATE (32–36°C)',
      cls: 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-300 border-yellow-500/30',
    };
  }
  if (hi <= 41) {
    return {
      label: lang === 'ta' ? 'அதிகம் (HIGH)' : 'HIGH (36–41°C)',
      cls: 'bg-orange-500/15 text-orange-800 dark:text-orange-300 border-orange-500/30',
    };
  }
  return {
    label: lang === 'ta' ? 'தீவிரம் (EXTREME)' : 'EXTREME (>41°C)',
    cls: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
  };
}

export const HotspotMap: React.FC<Props> = ({
  areas,
  reliefPoints,
  weatherStatus,
  lang,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const baseTileLayerRef = useRef<L.Layer | null>(null);
  const layersGroupRef = useRef<L.LayerGroup | null>(null);

  const [mapStyle, setMapStyle] = useState<MapBaseStyle>('street');
  const [showShade, setShowShade] = useState(true);
  const [showWater, setShowWater] = useState(true);
  const [showCooling, setShowCooling] = useState(true);

  const shadeCount = reliefPoints.filter((r) => r.type === 'shade').length;
  const waterCount = reliefPoints.filter((r) => r.type === 'water').length;
  const coolingCount = reliefPoints.filter((r) => r.type === 'cooling').length;

  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [13.05, 80.22],
      zoom: 11,
      minZoom: 10,
      maxZoom: 18,
    });

    baseTileLayerRef.current = attachBaseLayer(map, null, 'street');

    const layerGroup = L.layerGroup().addTo(map);
    layersGroupRef.current = layerGroup;
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      baseTileLayerRef.current = null;
      layersGroupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    baseTileLayerRef.current = attachBaseLayer(map, baseTileLayerRef.current, mapStyle);
  }, [mapStyle]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const layerGroup = layersGroupRef.current;
    if (!map || !layerGroup) return;

    layerGroup.clearLayers();

    // 1. Draw area circles colored by Heat Index (<33 green, 33-41 amber, >41 red)
    areas.forEach((a) => {
      const color = getHeatColor(a.heatIndex);
      const areaName = lang === 'ta' ? a.name_ta : a.name;

      const circle = L.circle([a.lat, a.lng], {
        color,
        fillColor: color,
        fillOpacity: 0.35,
        weight: 3,
        radius: 1700,
      });

      circle.bindPopup(`
        <div style="font-family: sans-serif; min-width: 185px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 800;">${areaName} (Ward ${a.ward_no})</h4>
          <div style="margin-top: 6px; font-size: 12px;">
            <div>Heat Index: <b style="color: ${color};">${a.heatIndex.toFixed(1)}°C</b></div>
            <div>Air Temp: <b>${a.temp.toFixed(1)}°C</b> &middot; Humidity: <b>${a.humidity}%</b></div>
            <div>Extreme Hours Today (&gt;41°C): <b>${a.extremeHoursToday}h</b></div>
          </div>
        </div>
      `);
      layerGroup.addLayer(circle);

      const labelIcon = L.divIcon({
        className: 'hotspot-area-label',
        html: `
          <div style="
            background: rgba(12, 10, 9, 0.84);
            color: #ffffff;
            font-size: 10px;
            font-weight: 700;
            padding: 2px 6px;
            border-radius: 5px;
            border-left: 3px solid ${color};
            white-space: nowrap;
            box-shadow: 0 2px 5px rgba(0,0,0,0.35);
          ">
            ${a.name} (${a.heatIndex.toFixed(1)}°C)
          </div>
        `,
        iconSize: [96, 20],
        iconAnchor: [48, 10],
      });
      layerGroup.addLayer(L.marker([a.lat, a.lng], { icon: labelIcon }));
    });

    // 2. Draw static relief points by independent layer toggles
    reliefPoints.forEach((rp) => {
      if (rp.type === 'shade' && !showShade) return;
      if (rp.type === 'water' && !showWater) return;
      if (rp.type === 'cooling' && !showCooling) return;

      let symbol = '💧';
      let bg = '#0284c7';
      let typeLabel = 'Water Point';
      if (rp.type === 'shade') {
        symbol = '☂️';
        bg = '#16a34a';
        typeLabel = 'Shade Shelter';
      } else if (rp.type === 'cooling') {
        symbol = '❄️';
        bg = '#7c3aed';
        typeLabel = 'Cooling Center';
      }

      const icon = L.divIcon({
        className: 'static-relief-pin',
        html: `<div style="background:${bg};color:white;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);">${symbol}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const title = lang === 'ta' ? rp.name_ta : rp.name;
      const addr = lang === 'ta' ? rp.address_ta : rp.address;
      const marker = L.marker([rp.lat, rp.lng], { icon });
      marker.bindPopup(
        `<div style="font-family:sans-serif;min-width:170px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:${bg};">${typeLabel}</div>
          <div style="font-size:12px;font-weight:800;margin-top:2px;">${title}</div>
          <div style="font-size:11px;color:#57534e;margin-top:2px;">${addr}</div>
        </div>`
      );
      layerGroup.addLayer(marker);
    });
  }, [areas, reliefPoints, showShade, showWater, showCooling, lang]);

  const top5Hottest = [...areas]
    .sort((a, b) => b.heatIndex - a.heatIndex || b.extremeHoursToday - a.extremeHoursToday)
    .slice(0, 5);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-[11px] font-extrabold uppercase tracking-widest text-rose-500">
            01 &middot; {lang === 'ta' ? 'வெப்ப மையங்கள்' : 'HOTSPOTS'}
          </span>
          <h3 className="text-base sm:text-lg font-black text-stone-900 dark:text-stone-100">
            {lang === 'ta'
              ? 'சென்னை நேரடி வெப்ப அழுத்த வரைபடம்'
              : 'Live Area Heat Index Map & Top 5 Hotspots'}
          </h3>
        </div>

        {/* Layer toggles for Street/Satellite, shade, water, and cooling points */}
        <div className="flex flex-wrap items-center gap-2 bg-white dark:bg-stone-900 px-3 py-2 rounded-2xl border border-stone-200 dark:border-stone-800 shadow-xs">
          <div className="inline-flex items-center rounded-xl bg-stone-100 dark:bg-stone-800 p-0.5 border border-stone-200 dark:border-stone-700 mr-1">
            <button
              type="button"
              onClick={() => setMapStyle('street')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
                mapStyle === 'street'
                  ? 'bg-orange-600 text-white shadow-xs'
                  : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-white'
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" />
              <span>{lang === 'ta' ? 'தெரு' : 'Street'}</span>
            </button>
            <button
              type="button"
              onClick={() => setMapStyle('satellite')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer whitespace-nowrap shrink-0 ${
                mapStyle === 'satellite'
                  ? 'bg-orange-600 text-white shadow-xs'
                  : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-white'
              }`}
            >
              <Satellite className="w-3.5 h-3.5" />
              <span>{lang === 'ta' ? 'செயற்கைக்கோள்' : 'Satellite'}</span>
            </button>
          </div>

          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-stone-600 dark:text-stone-300 mr-1">
            <Layers className="w-3.5 h-3.5 text-orange-500" />
            {lang === 'ta' ? 'அடுக்குகள்:' : 'Layers:'}
          </span>

          <button
            type="button"
            onClick={() => setShowShade((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
              showShade
                ? 'bg-emerald-600 text-white border-emerald-500 shadow-xs'
                : 'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-700'
            }`}
          >
            <Umbrella className="w-3.5 h-3.5" />
            <span>{lang === 'ta' ? `நிழல் (${shadeCount})` : `Shade (${shadeCount})`}</span>
          </button>

          <button
            type="button"
            onClick={() => setShowWater((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
              showWater
                ? 'bg-sky-600 text-white border-sky-500 shadow-xs'
                : 'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-700'
            }`}
          >
            <Droplets className="w-3.5 h-3.5" />
            <span>{lang === 'ta' ? `தண்ணீர் (${waterCount})` : `Water (${waterCount})`}</span>
          </button>

          <button
            type="button"
            onClick={() => setShowCooling((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-bold border transition cursor-pointer ${
              showCooling
                ? 'bg-violet-600 text-white border-violet-500 shadow-xs'
                : 'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-700'
            }`}
          >
            <Snowflake className="w-3.5 h-3.5" />
            <span>{lang === 'ta' ? `குளிர் (${coolingCount})` : `Cooling (${coolingCount})`}</span>
          </button>
        </div>
      </div>

      {/* Main Map + Right Panel Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
        {/* Leaflet + OpenStreetMap Map */}
        <div className="lg:col-span-8 flex flex-col gap-2">
          <div className="relative w-full h-[420px] sm:h-[470px] rounded-3xl overflow-hidden shadow-md border border-stone-200 dark:border-stone-800">
            <div ref={mapContainerRef} className="w-full h-full" />
          </div>

          {/* Heat Index Color Legend */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 rounded-2xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-[11px] font-bold">
            <div className="flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center gap-1.5 text-stone-700 dark:text-stone-300">
                <span className="w-3 h-3 rounded-full bg-[#22c55e] inline-block" />
                {lang === 'ta' ? '< 32°C குறைவு' : '< 32°C Low'}
              </span>
              <span className="inline-flex items-center gap-1.5 text-stone-700 dark:text-stone-300">
                <span className="w-3 h-3 rounded-full bg-[#eab308] inline-block" />
                {lang === 'ta' ? '32–36°C மிதமான' : '32–36°C Moderate'}
              </span>
              <span className="inline-flex items-center gap-1.5 text-stone-700 dark:text-stone-300">
                <span className="w-3 h-3 rounded-full bg-[#f97316] inline-block" />
                {lang === 'ta' ? '36–41°C அதிகம்' : '36–41°C High'}
              </span>
              <span className="inline-flex items-center gap-1.5 text-stone-700 dark:text-stone-300">
                <span className="w-3 h-3 rounded-full bg-[#ef4444] inline-block" />
                {lang === 'ta' ? '> 41°C தீவிரம்' : '> 41°C Extreme'}
              </span>
            </div>
            <span className="text-stone-500 dark:text-stone-400">
              {lang === 'ta'
                ? 'தரவு: getReadings() & heatIndex()'
                : 'Computed via getReadings() & heatIndex()'}
            </span>
          </div>
        </div>

        {/* Right Panel: Live/Offline Badge + Top 5 Hottest Areas Now */}
        <div className="lg:col-span-4 bg-white dark:bg-stone-900 rounded-3xl p-4 sm:p-5 border border-stone-200 dark:border-stone-800 shadow-sm flex flex-col justify-between gap-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-stone-200 dark:border-stone-800 pb-3">
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-rose-500" />
                <h4 className="text-sm font-black text-stone-900 dark:text-stone-100">
                  {lang === 'ta' ? 'இப்போது அதிக வெப்பமான 5 பகுதிகள்' : 'Top 5 Hottest Areas Now'}
                </h4>
              </div>

              {/* Live / Offline Badge */}
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-extrabold border ${
                  weatherStatus.isLive
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                    : 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30'
                }`}
              >
                {weatherStatus.isLive ? (
                  <Wifi className="w-3 h-3" />
                ) : (
                  <WifiOff className="w-3 h-3" />
                )}
                <span>{weatherStatus.badge || (weatherStatus.isLive ? 'Live' : 'Offline')}</span>
              </span>
            </div>

            <div className="space-y-2.5">
              {top5Hottest.map((area, idx) => {
                const risk = getRiskTag(area.heatIndex, lang);
                const barColor = getHeatColor(area.heatIndex);

                return (
                  <div
                    key={area.id}
                    className="p-3 rounded-2xl bg-stone-50 dark:bg-stone-950/70 border border-stone-200/80 dark:border-stone-800 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="w-7 h-7 rounded-xl flex items-center justify-center text-xs font-black text-white shrink-0"
                        style={{ backgroundColor: barColor }}
                      >
                        #{idx + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs sm:text-sm font-extrabold text-stone-900 dark:text-stone-100 truncate">
                          {lang === 'ta' ? area.name_ta : area.name}
                        </div>
                        <div className="text-[11px] text-stone-500 dark:text-stone-400">
                          {lang === 'ta'
                            ? `இன்று >41°C: ${area.extremeHoursToday} மணி`
                            : `Extreme hours today: ${area.extremeHoursToday}h`}
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-base font-black text-stone-900 dark:text-white">
                        {area.heatIndex.toFixed(1)}°C
                      </div>
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${risk.cls}`}
                      >
                        {risk.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="text-[11px] text-stone-500 dark:text-stone-400 pt-2 border-t border-stone-200 dark:border-stone-800">
            {lang === 'ta'
              ? 'நிவாரண இடங்கள்: data/relief-points.json (படிக்க மட்டும்)'
              : 'Static relief inventory loaded from data/relief-points.json (read-only).'}
          </div>
        </div>
      </div>
    </section>
  );
};
