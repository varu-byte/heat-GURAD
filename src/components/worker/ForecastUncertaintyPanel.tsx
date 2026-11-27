import React, { useEffect, useMemo, useState } from 'react';
import {
  ExtendedForecastHour,
  ExtendedForecastResponse,
  ForecastHorizon,
  Language,
} from '../../types';
import { fetchExtendedForecast } from '../../services/intelligenceApi';
import { RISK_CONFIG } from '../../utils/heatIndex';
import {
  AlertTriangle,
  Calendar,
  Cloud,
  Droplets,
  Info,
  RefreshCw,
  Thermometer,
  TrendingUp,
} from 'lucide-react';

interface Props {
  lat: number;
  lng: number;
  locationLabel: string;
  lang: Language;
}

export const ForecastUncertaintyPanel: React.FC<Props> = ({
  lat,
  lng,
  locationLabel,
  lang,
}) => {
  const [horizon, setHorizon] = useState<ForecastHorizon>(48);
  const [data, setData] = useState<ExtendedForecastResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [showAirTempSeries, setShowAirTempSeries] = useState<boolean>(true);
  const [reloadNonce, setReloadNonce] = useState<number>(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchExtendedForecast({
      lat,
      lng,
      label: locationLabel,
      horizonHours: horizon,
      signal: controller.signal,
    })
      .then((res) => {
        setData(res);
        setHoveredIdx(null);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err?.message || 'Unable to load extended forecast.');
      })
      .finally(() => {
        setLoading(false);
      });

    return () => controller.abort();
  }, [lat, lng, locationLabel, horizon, reloadNonce]);

  const hours = data?.hours || [];
  const activeHour: ExtendedForecastHour | null = useMemo(() => {
    if (hours.length === 0) return null;
    if (hoveredIdx !== null && hours[hoveredIdx]) return hours[hoveredIdx];
    // Default to peak Heat Index hour in horizon
    return hours.reduce((best, cur) => (cur.heatIndex > best.heatIndex ? cur : best), hours[0]);
  }, [hours, hoveredIdx]);

  // SVG chart coordinate math
  const chart = useMemo(() => {
    if (hours.length < 2) return null;
    const width = 680;
    const height = 190;
    const padL = 36;
    const padR = 14;
    const padT = 16;
    const padB = 26;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;

    const allVals: number[] = [];
    hours.forEach((h) => {
      allVals.push(h.heatIndex, h.temp);
      if (h.heatIndexMin !== null) allVals.push(h.heatIndexMin);
      if (h.heatIndexMax !== null) allVals.push(h.heatIndexMax);
    });

    const minY = Math.floor(Math.min(...allVals, 24) - 1);
    const maxY = Math.ceil(Math.max(...allVals, 44) + 1);
    const spanY = Math.max(8, maxY - minY);

    const xAt = (i: number) => padL + (i / (hours.length - 1)) * innerW;
    const yAt = (val: number) => padT + innerH - ((val - minY) / spanY) * innerH;

    const hiLine = hours
      .map((h, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(h.heatIndex).toFixed(1)}`)
      .join(' ');

    const tempLine = hours
      .map((h, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(h.temp).toFixed(1)}`)
      .join(' ');

    const hasRange = hours.some((h) => h.heatIndexMin !== null && h.heatIndexMax !== null);
    let bandPath = '';
    if (hasRange) {
      const upper = hours
        .map((h, i) => {
          const val = h.heatIndexMax ?? h.heatIndex;
          return `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(val).toFixed(1)}`;
        })
        .join(' ');
      const lower = [...hours]
        .reverse()
        .map((h, revIdx) => {
          const origIdx = hours.length - 1 - revIdx;
          const val = h.heatIndexMin ?? h.heatIndex;
          return `L ${xAt(origIdx).toFixed(1)} ${yAt(val).toFixed(1)}`;
        })
        .join(' ');
      bandPath = `${upper} ${lower} Z`;
    }

    const dayMarkers = hours
      .map((h, idx) => ({ h, idx }))
      .filter(({ h, idx }) => idx === 0 || h.hourLabel === '00:00');

    return {
      width,
      height,
      padL,
      padR,
      padT,
      padB,
      minY,
      maxY,
      xAt,
      yAt,
      hiLine,
      tempLine,
      bandPath,
      hasRange,
      dayMarkers,
    };
  }, [hours]);

  const uncertaintyBadge = useMemo(() => {
    if (!data) return null;
    if (data.uncertaintySource === 'open-meteo-ensemble') {
      return {
        label: lang === 'ta' ? 'பல்-மாதிரி வரம்பு' : 'Ensemble Spread Range',
        cls: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
      };
    }
    if (data.uncertaintySource === 'empirical-calibration') {
      return {
        label:
          lang === 'ta'
            ? `வரலாற்று அளவுத்திருத்தம் (±${data.calibration.maeHeatIndexC}°C MAE)`
            : `Calibrated MAE (±${data.calibration.maeHeatIndexC}°C)`,
        cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
      };
    }
    return {
      label: lang === 'ta' ? 'அளவுத்திருத்தம் இல்லாத மதிப்பீடு' : 'Uncalibrated Estimate',
      cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-500/30',
    };
  }, [data, lang]);

  return (
    <section className="bg-white dark:bg-stone-900 rounded-2xl p-4 sm:p-5 shadow-sm border border-stone-200 dark:border-stone-800 space-y-4">
      {/* Section Header & Horizon Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <TrendingUp className="w-4 h-4 text-orange-500 shrink-0" />
            <h2 className="text-sm sm:text-base font-black text-stone-900 dark:text-stone-100">
              {lang === 'ta'
                ? '24h / 48h / 72h வெப்ப முன்னறிவிப்பு & நிச்சயமற்ற நிலை'
                : '24h / 48h / 72h Forecast With Uncertainty'}
            </h2>
          </div>
          <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5">
            {locationLabel} ·{' '}
            {lang === 'ta'
              ? 'நீண்ட நேர முன்னறிவிப்புகளில் நிச்சயமற்ற தன்மை அதிகரிக்கும்'
              : 'Longer-range forecasts carry wider uncertainty and are not guaranteed'}
          </p>
        </div>

        <div className="flex items-center gap-1.5 self-start sm:self-auto">
          <div className="inline-flex items-center rounded-xl bg-stone-100 dark:bg-stone-800 p-1 border border-stone-200 dark:border-stone-700">
            {([24, 48, 72] as ForecastHorizon[]).map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setHorizon(h)}
                className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition cursor-pointer whitespace-nowrap shrink-0 tabular-nums ${
                  horizon === h
                    ? 'bg-orange-600 text-white shadow-xs'
                    : 'text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-white'
                }`}
              >
                {h}h
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            disabled={loading}
            className="p-2 rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-800 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 cursor-pointer disabled:opacity-50"
            aria-label="Refresh extended forecast"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Loading / Error State */}
      {loading && !data && (
        <div className="flex items-center justify-center py-8 gap-2 text-xs text-stone-500">
          <RefreshCw className="w-4 h-4 animate-spin text-orange-500" />
          <span>Loading {horizon}h forecast &amp; ensemble spread...</span>
        </div>
      )}

      {error && (
        <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="px-2.5 py-1 rounded-lg bg-amber-600 text-white font-bold cursor-pointer shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main Content when Data Available */}
      {data && hours.length > 0 && (
        <>
          {/* Source & Uncertainty Status Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-2">
              {uncertaintyBadge && (
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-bold border ${uncertaintyBadge.cls}`}
                >
                  <Info className="w-3.5 h-3.5" />
                  {uncertaintyBadge.label}
                </span>
              )}
              <span className="text-stone-500 dark:text-stone-400 tabular-nums">
                {data.calibration.pairedSamplesCount > 0
                  ? `${data.calibration.pairedSamplesCount} paired obs logged`
                  : '0 paired obs logged yet'}
              </span>
            </div>

            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-600 dark:text-stone-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showAirTempSeries}
                onChange={(e) => setShowAirTempSeries(e.target.checked)}
                className="accent-orange-600 rounded"
              />
              <span>Show Air Temp line</span>
            </label>
          </div>

          {/* Active / Hovered Hour Inspection Strip */}
          {activeHour && (
            <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 grid grid-cols-2 sm:grid-cols-5 gap-2 items-center tabular-nums">
              <div>
                <span className="text-[10px] font-bold uppercase text-stone-500 block">
                  {hoveredIdx !== null ? 'Selected Hour' : 'Forecast Peak'}
                </span>
                <span className="text-xs font-extrabold text-stone-900 dark:text-stone-100">
                  {activeHour.dayLabel} · {activeHour.hourLabel}
                </span>
              </div>

              <div>
                <span className="text-[10px] font-bold uppercase text-stone-500 block">
                  Feels Like
                </span>
                <span className="text-sm font-black text-orange-600 dark:text-orange-400">
                  {activeHour.heatIndex}°C
                </span>
                {activeHour.heatIndexMin !== null && activeHour.heatIndexMax !== null && (
                  <span className="block text-[10px] text-stone-500">
                    Range {activeHour.heatIndexMin}–{activeHour.heatIndexMax}°C
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <Thermometer className="w-3.5 h-3.5 text-orange-500 shrink-0" />
                <div>
                  <span className="text-[10px] text-stone-500 block">Air Temp</span>
                  <span className="text-xs font-extrabold text-stone-900 dark:text-stone-100">
                    {activeHour.temp}°C
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Droplets className="w-3.5 h-3.5 text-cyan-500 shrink-0" />
                <div>
                  <span className="text-[10px] text-stone-500 block">Humidity · Cloud</span>
                  <span className="text-xs font-extrabold text-stone-900 dark:text-stone-100">
                    {activeHour.humidity}% ·{' '}
                    <Cloud className="w-3 h-3 inline text-stone-400" />{' '}
                    {activeHour.cloudCoverPct !== null ? `${activeHour.cloudCoverPct}%` : 'N/A'}
                  </span>
                </div>
              </div>

              <div className="text-left sm:text-right">
                <span
                  className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-black uppercase ${RISK_CONFIG[activeHour.risk].badgeClass}`}
                >
                  {lang === 'ta'
                    ? RISK_CONFIG[activeHour.risk].labelTa
                    : RISK_CONFIG[activeHour.risk].labelEn}
                </span>
              </div>
            </div>
          )}

          {/* Interactive SVG Forecast Curve + Uncertainty Band */}
          {chart && (
            <div className="w-full overflow-x-auto">
              <svg
                viewBox={`0 0 ${chart.width} ${chart.height}`}
                className="w-full min-w-[480px] h-auto select-none"
                role="img"
                aria-label={`${horizon}-hour Heat Index forecast with uncertainty band`}
              >
                {/* Threshold lines (32°C Moderate, 36°C High, 41°C Extreme) */}
                {[
                  { val: 32, label: '32°', color: '#eab308' },
                  { val: 36, label: '36°', color: '#f97316' },
                  { val: 41, label: '41°', color: '#ef4444' },
                ].map((tLine) => {
                  if (tLine.val < chart.minY || tLine.val > chart.maxY) return null;
                  const y = chart.yAt(tLine.val);
                  return (
                    <g key={tLine.val}>
                      <line
                        x1={chart.padL}
                        x2={chart.width - chart.padR}
                        y1={y}
                        y2={y}
                        stroke={tLine.color}
                        strokeOpacity={0.35}
                        strokeDasharray="4 4"
                      />
                      <text
                        x={chart.padL - 5}
                        y={y + 3}
                        textAnchor="end"
                        fontSize="9"
                        fill={tLine.color}
                        fontWeight="700"
                      >
                        {tLine.label}
                      </text>
                    </g>
                  );
                })}

                {/* Day boundary labels */}
                {chart.dayMarkers.map(({ h, idx }) => {
                  const x = chart.xAt(idx);
                  return (
                    <g key={`${h.dayLabel}-${idx}`}>
                      <line
                        x1={x}
                        x2={x}
                        y1={chart.padT}
                        y2={chart.height - chart.padB}
                        stroke="#78716c"
                        strokeOpacity={0.22}
                      />
                      <text
                        x={x + 4}
                        y={chart.height - 7}
                        fontSize="10"
                        fill="#78716c"
                        fontWeight="700"
                      >
                        {h.dayLabel}
                      </text>
                    </g>
                  );
                })}

                {/* Shaded Uncertainty Band */}
                {chart.hasRange && chart.bandPath && (
                  <path d={chart.bandPath} fill="#f97316" fillOpacity={0.18} />
                )}

                {/* Air Temperature secondary dashed line */}
                {showAirTempSeries && (
                  <path
                    d={chart.tempLine}
                    fill="none"
                    stroke="#0284c7"
                    strokeWidth="1.75"
                    strokeDasharray="3 3"
                  />
                )}

                {/* Primary Feels-Like Heat Index line */}
                <path
                  d={chart.hiLine}
                  fill="none"
                  stroke="#ea580c"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                {/* Active hour marker */}
                {activeHour && (() => {
                  const idx = hours.indexOf(activeHour);
                  if (idx < 0) return null;
                  const cx = chart.xAt(idx);
                  const cy = chart.yAt(activeHour.heatIndex);
                  return (
                    <g>
                      <line
                        x1={cx}
                        x2={cx}
                        y1={chart.padT}
                        y2={chart.height - chart.padB}
                        stroke="#ea580c"
                        strokeOpacity={0.45}
                        strokeDasharray="2 2"
                      />
                      <circle cx={cx} cy={cy} r={4.5} fill="#ea580c" stroke="#ffffff" strokeWidth={1.5} />
                    </g>
                  );
                })()}

                {/* Invisible interactive scrub columns */}
                {hours.map((h, idx) => {
                  const colW = (chart.width - chart.padL - chart.padR) / hours.length;
                  return (
                    <rect
                      key={h.timeIso}
                      x={chart.xAt(idx) - colW / 2}
                      y={chart.padT}
                      width={Math.max(colW, 6)}
                      height={chart.height - chart.padT - chart.padB}
                      fill="transparent"
                      className="cursor-crosshair"
                      onMouseEnter={() => setHoveredIdx(idx)}
                      onClick={() => setHoveredIdx(idx)}
                    />
                  );
                })}
              </svg>

              <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-stone-500 mt-1">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-0.5 bg-orange-600 inline-block" /> Feels-like Heat Index
                  </span>
                  {chart.hasRange && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-3 h-2.5 bg-orange-500/25 border border-orange-500/40 inline-block rounded-xs" />
                      Uncertainty Range (Min–Max)
                    </span>
                  )}
                  {showAirTempSeries && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-3 h-0.5 border-t border-dashed border-sky-600 inline-block" />{' '}
                      Air Temp
                    </span>
                  )}
                </div>
                <span>Hover or tap chart hours to inspect</span>
              </div>
            </div>
          )}

          {/* Daily Summary Cards (Expected changes per day) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {data.dailySummaries.map((day) => {
              const riskCfg = RISK_CONFIG[day.peakRisk];
              return (
                <div
                  key={day.dayIndex}
                  className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 space-y-2 tabular-nums"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-xs font-extrabold text-stone-900 dark:text-stone-100">
                      <Calendar className="w-3.5 h-3.5 text-orange-500" />
                      {day.dateLabel}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${riskCfg.badgeClass}`}>
                      {day.peakRisk}
                    </span>
                  </div>

                  <div className="flex items-baseline justify-between">
                    <div>
                      <span className="text-[10px] text-stone-500 block">Peak Feels Like</span>
                      <span className="text-lg font-black text-stone-900 dark:text-white">
                        {day.peakHeatIndex}°C
                      </span>
                      {day.peakHeatIndexMin !== null && day.peakHeatIndexMax !== null && (
                        <span className="text-[10px] text-stone-500 ml-1">
                          ({day.peakHeatIndexMin}–{day.peakHeatIndexMax}°)
                        </span>
                      )}
                    </div>
                    <div className="text-right text-[11px] text-stone-600 dark:text-stone-300">
                      <div>
                        Air {day.minTemp}–{day.peakTemp}°C
                      </div>
                      <div>RH ~{day.avgHumidity}%</div>
                    </div>
                  </div>

                  <div className="pt-1.5 border-t border-stone-200/70 dark:border-stone-800 text-[10px] space-y-0.5 text-stone-600 dark:text-stone-400">
                    <div>
                      <span className="font-bold text-emerald-700 dark:text-emerald-400">Safer:</span>{' '}
                      {day.saferWindow}
                    </div>
                    <div>
                      <span className="font-bold text-rose-700 dark:text-rose-400">Risky:</span>{' '}
                      {day.riskyWindow}
                      {day.extremeHoursCount > 0 ? ` (${day.extremeHoursCount}h extreme)` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Transparent Uncertainty & Calibration Explanation */}
          <div className="p-3 rounded-xl bg-stone-50 dark:bg-stone-950 border border-stone-200 dark:border-stone-800 flex items-start gap-2.5 text-xs text-stone-600 dark:text-stone-300">
            {data.uncertaintySource === 'uncalibrated' ? (
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            ) : (
              <Info className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <p className="font-semibold text-stone-800 dark:text-stone-200">
                {data.uncertaintyMethodNote}
              </p>
              <p className="text-[11px] text-stone-500 dark:text-stone-400">
                {data.calibration.note} Forecast ranges are empirical/ensemble indicators—not
                guarantees or exact confidence percentages.
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
};
