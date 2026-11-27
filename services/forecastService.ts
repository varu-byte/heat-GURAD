import fs from 'fs';
import path from 'path';
import {
  ExtendedForecastHour,
  ExtendedForecastResponse,
  ForecastCalibrationSummary,
  ForecastDaySummary,
  ForecastHorizon,
} from '../src/types';
import {
  calculateRothfusz,
  fetchOpenMeteoJson,
  getRiskLevel,
  roundCoordKey,
} from './weather';

const RUNTIME_DIR = path.join(process.cwd(), '.runtime');
const CALIBRATION_PATH = path.join(RUNTIME_DIR, 'forecast-calibration.json');

interface CalibrationStore {
  loggedPredictions: Array<{
    locationKey: string;
    targetHourIso: string;
    predictedTemp: number;
    predictedHeatIndex: number;
    recordedAtIso: string;
  }>;
  pairedErrors: Array<{
    targetHourIso: string;
    absTempErr: number;
    absHiErr: number;
  }>;
}

function loadCalibrationStore(): CalibrationStore {
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      return JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf-8')) as CalibrationStore;
    }
  } catch {
    // Ignore parse error
  }
  return { loggedPredictions: [], pairedErrors: [] };
}

function saveCalibrationStore(data: CalibrationStore): void {
  try {
    if (!fs.existsSync(RUNTIME_DIR)) {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    }
    if (data.loggedPredictions.length > 240) {
      data.loggedPredictions = data.loggedPredictions.slice(-240);
    }
    if (data.pairedErrors.length > 180) {
      data.pairedErrors = data.pairedErrors.slice(-180);
    }
    fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Ignore disk write failure on read-only environments
  }
}

function updateAndGetCalibration(
  locationKey: string,
  observedHourIso: string | undefined,
  observedTemp: number | undefined,
  observedHumidity: number | undefined,
  upcomingHours: Array<{ timeIso: string; temp: number; heatIndex: number }>
): ForecastCalibrationSummary {
  const store = loadCalibrationStore();

  // Match current observation against any previously logged forecast for the same hour
  if (
    observedHourIso &&
    typeof observedTemp === 'number' &&
    typeof observedHumidity === 'number'
  ) {
    const observedHi = calculateRothfusz(observedTemp, observedHumidity);
    const matchingIdx = store.loggedPredictions.findIndex(
      (p) =>
        p.locationKey === locationKey &&
        p.targetHourIso.slice(0, 13) === observedHourIso.slice(0, 13)
    );

    if (matchingIdx >= 0) {
      const prior = store.loggedPredictions[matchingIdx];
      const alreadyPaired = store.pairedErrors.some(
        (e) => e.targetHourIso.slice(0, 13) === observedHourIso.slice(0, 13)
      );
      if (!alreadyPaired) {
        store.pairedErrors.push({
          targetHourIso: observedHourIso,
          absTempErr: Math.round(Math.abs(prior.predictedTemp - observedTemp) * 10) / 10,
          absHiErr: Math.round(Math.abs(prior.predictedHeatIndex - observedHi) * 10) / 10,
        });
      }
    }
  }

  // Log upcoming forecast snapshot if not already logged for that hour
  const nowIso = new Date().toISOString();
  for (const h of upcomingHours.slice(0, 24)) {
    const exists = store.loggedPredictions.some(
      (p) =>
        p.locationKey === locationKey &&
        p.targetHourIso.slice(0, 13) === h.timeIso.slice(0, 13)
    );
    if (!exists) {
      store.loggedPredictions.push({
        locationKey,
        targetHourIso: h.timeIso,
        predictedTemp: h.temp,
        predictedHeatIndex: h.heatIndex,
        recordedAtIso: nowIso,
      });
    }
  }

  saveCalibrationStore(store);

  const count = store.pairedErrors.length;
  if (count < 6) {
    return {
      calibrated: false,
      pairedSamplesCount: count,
      maeTempC: null,
      maeHeatIndexC: null,
      note: `Uncalibrated against local observations (${count}/6 paired forecast-vs-observation hours collected so far).`,
    };
  }

  const maeTempC =
    Math.round(
      (store.pairedErrors.reduce((s, e) => s + e.absTempErr, 0) / count) * 10
    ) / 10;
  const maeHeatIndexC =
    Math.round(
      (store.pairedErrors.reduce((s, e) => s + e.absHiErr, 0) / count) * 10
    ) / 10;

  return {
    calibrated: true,
    pairedSamplesCount: count,
    maeTempC,
    maeHeatIndexC,
    note: `Empirical historical verification across ${count} paired hours: mean absolute error ±${maeTempC}°C air temp, ±${maeHeatIndexC}°C Heat Index.`,
  };
}

/**
 * Fetches Open-Meteo Ensemble spread when supported by Open-Meteo.
 * Returns per-hour { tempMin, tempMax, humMin, humMax } arrays if available, else null.
 */
async function fetchEnsembleSpread(
  lat: number,
  lng: number,
  horizonHours: ForecastHorizon
): Promise<{
  tempMin: number[];
  tempMax: number[];
  humMin: number[];
  humMax: number[];
} | null> {
  const days = horizonHours <= 24 ? 1 : horizonHours <= 48 ? 2 : 3;
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&hourly=temperature_2m,relative_humidity_2m&models=gfs_seamless&timezone=Asia/Kolkata&forecast_days=${days}`;
  const cacheKey = `ens:${roundCoordKey(lat, lng, 2)}:d${days}`;

  try {
    const { data: json } = await fetchOpenMeteoJson<{ hourly?: Record<string, any> }>(
      url,
      cacheKey,
      { ttlMs: 15 * 60 * 1000, timeoutMs: 6500, maxRetries: 1, allowStaleOnError: true }
    );
    const hourly = json.hourly;
    if (!hourly || !Array.isArray(hourly.time)) return null;

    const tempMemberKeys = Object.keys(hourly).filter((k) =>
      k.startsWith('temperature_2m_member')
    );
    const humMemberKeys = Object.keys(hourly).filter((k) =>
      k.startsWith('relative_humidity_2m_member')
    );

    if (tempMemberKeys.length < 2) return null;

    const len = hourly.time.length;
    const tempMin: number[] = [];
    const tempMax: number[] = [];
    const humMin: number[] = [];
    const humMax: number[] = [];

    for (let i = 0; i < len; i++) {
      const tVals = tempMemberKeys
        .map((k) => hourly[k]?.[i])
        .filter((v): v is number => typeof v === 'number');
      const hVals = humMemberKeys
        .map((k) => hourly[k]?.[i])
        .filter((v): v is number => typeof v === 'number');

      if (tVals.length >= 2) {
        tempMin.push(Math.round(Math.min(...tVals) * 10) / 10);
        tempMax.push(Math.round(Math.max(...tVals) * 10) / 10);
      } else {
        tempMin.push(NaN);
        tempMax.push(NaN);
      }

      if (hVals.length >= 2) {
        humMin.push(Math.round(Math.min(...hVals)));
        humMax.push(Math.round(Math.max(...hVals)));
      } else {
        humMin.push(NaN);
        humMax.push(NaN);
      }
    }

    return { tempMin, tempMax, humMin, humMax };
  } catch {
    return null;
  }
}

/**
 * Fetches 24h, 48h, or 72h forecast with real ensemble uncertainty spread & calibration tracking.
 */
export async function getExtendedForecastWithUncertainty(params: {
  lat: number;
  lng: number;
  label?: string;
  horizonHours?: ForecastHorizon;
}): Promise<ExtendedForecastResponse> {
  const lat = params.lat;
  const lng = params.lng;
  const label = params.label || 'Chennai Region';
  const horizonHours: ForecastHorizon =
    params.horizonHours === 48 ? 48 : params.horizonHours === 72 ? 72 : 24;
  const days = horizonHours <= 24 ? 1 : horizonHours <= 48 ? 2 : 3;

  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&current=temperature_2m,relative_humidity_2m&hourly=temperature_2m,relative_humidity_2m,cloud_cover&timezone=Asia/Kolkata&forecast_days=${days}`;
  const cacheKey = `fc:${roundCoordKey(lat, lng, 2)}:d${days}`;

  let mainJson: any = null;
  let isLive = true;

  try {
    const [mainFetched, ensemble] = await Promise.all([
      fetchOpenMeteoJson<any>(forecastUrl, cacheKey, {
        ttlMs: 12 * 60 * 1000,
        timeoutMs: 7500,
        maxRetries: 2,
        allowStaleOnError: true,
      }),
      fetchEnsembleSpread(lat, lng, horizonHours),
    ]);
    mainJson = mainFetched.data;

    const times: string[] = mainJson.hourly?.time || [];
    const temps: number[] = mainJson.hourly?.temperature_2m || [];
    const humidities: number[] = mainJson.hourly?.relative_humidity_2m || [];
    const clouds: number[] = mainJson.hourly?.cloud_cover || [];

    const totalLen = Math.min(horizonHours, times.length);
    const hours: ExtendedForecastHour[] = [];

    for (let i = 0; i < totalLen; i++) {
      const timeIso = times[i];
      const temp = Math.round((temps[i] ?? 30) * 10) / 10;
      const humidity = Math.round(humidities[i] ?? 65);
      const cloudCoverPct =
        typeof clouds[i] === 'number' ? Math.round(clouds[i]) : null;
      const hi = calculateRothfusz(temp, humidity);
      const risk = getRiskLevel(hi);

      const dayIndex = Math.floor(i / 24);
      const dayLabel =
        dayIndex === 0 ? 'Day 1 (Today)' : dayIndex === 1 ? 'Day 2 (+24–48h)' : 'Day 3 (+48–72h)';
      const hourLabel = timeIso.includes('T')
        ? timeIso.split('T')[1].slice(0, 5)
        : `${(i % 24).toString().padStart(2, '0')}:00`;

      let tempMin: number | null = null;
      let tempMax: number | null = null;
      let heatIndexMin: number | null = null;
      let heatIndexMax: number | null = null;

      if (
        ensemble &&
        Number.isFinite(ensemble.tempMin[i]) &&
        Number.isFinite(ensemble.tempMax[i])
      ) {
        tempMin = ensemble.tempMin[i];
        tempMax = ensemble.tempMax[i];
        const hLow = Number.isFinite(ensemble.humMin[i]) ? ensemble.humMin[i] : humidity;
        const hHigh = Number.isFinite(ensemble.humMax[i]) ? ensemble.humMax[i] : humidity;
        const hiLowCandidate = calculateRothfusz(tempMin, hLow);
        const hiHighCandidate = calculateRothfusz(tempMax, hHigh);
        heatIndexMin = Math.min(hi, hiLowCandidate, hiHighCandidate);
        heatIndexMax = Math.max(hi, hiLowCandidate, hiHighCandidate);
      }

      hours.push({
        timeIso,
        hourLabel,
        dayIndex,
        dayLabel,
        temp,
        tempMin,
        tempMax,
        humidity,
        heatIndex: hi,
        heatIndexMin,
        heatIndexMax,
        cloudCoverPct,
        risk,
      });
    }

    const locationKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const calibration = updateAndGetCalibration(
      locationKey,
      mainJson.current?.time,
      mainJson.current?.temperature_2m,
      mainJson.current?.relative_humidity_2m,
      hours.map((h) => ({ timeIso: h.timeIso, temp: h.temp, heatIndex: h.heatIndex }))
    );

    // If ensemble unavailable AND calibrated empirical MAE exists, fill empirical bounds cleanly
    const hasEnsemble = Boolean(
      ensemble && hours.some((h) => h.heatIndexMin !== null && h.heatIndexMax !== null)
    );
    if (!hasEnsemble && calibration.calibrated && calibration.maeHeatIndexC !== null && calibration.maeTempC !== null) {
      hours.forEach((h) => {
        // Empirical MAE scales modestly at longer days only as empirical observation band indicator
        const horizonScale = h.dayIndex === 0 ? 1 : h.dayIndex === 1 ? 1.25 : 1.5;
        const hiBand = Math.round(calibration.maeHeatIndexC! * horizonScale * 10) / 10;
        const tBand = Math.round(calibration.maeTempC! * horizonScale * 10) / 10;
        h.tempMin = Math.round((h.temp - tBand) * 10) / 10;
        h.tempMax = Math.round((h.temp + tBand) * 10) / 10;
        h.heatIndexMin = Math.round((h.heatIndex - hiBand) * 10) / 10;
        h.heatIndexMax = Math.round((h.heatIndex + hiBand) * 10) / 10;
      });
    }

    const dailySummaries: ForecastDaySummary[] = [];
    for (let d = 0; d < days; d++) {
      const slice = hours.filter((h) => h.dayIndex === d);
      if (slice.length === 0) continue;

      const peakTemp = Math.max(...slice.map((h) => h.temp));
      const minTemp = Math.min(...slice.map((h) => h.temp));
      const peakHour = slice.reduce((best, cur) =>
        cur.heatIndex > best.heatIndex ? cur : best
      );
      const avgHumidity = Math.round(
        slice.reduce((s, h) => s + h.humidity, 0) / slice.length
      );
      const extremeHoursCount = slice.filter((h) => h.risk === 'extreme').length;
      const saferHours = slice.filter((h) => h.risk === 'low' || h.risk === 'moderate');
      const riskyHours = slice.filter((h) => h.risk === 'high' || h.risk === 'extreme');

      dailySummaries.push({
        dayIndex: d,
        dateLabel: slice[0].dayLabel,
        peakTemp,
        minTemp,
        peakHeatIndex: peakHour.heatIndex,
        peakHeatIndexMin: peakHour.heatIndexMin,
        peakHeatIndexMax: peakHour.heatIndexMax,
        avgHumidity,
        peakRisk: peakHour.risk,
        extremeHoursCount,
        saferWindow:
          saferHours.length > 0
            ? `${saferHours[0].hourLabel} – ${saferHours[saferHours.length - 1].hourLabel}`
            : 'Pre-dawn hours only',
        riskyWindow:
          riskyHours.length > 0
            ? `${riskyHours[0].hourLabel} – ${riskyHours[riskyHours.length - 1].hourLabel}`
            : 'No high/extreme peak hours forecast',
      });
    }

    const uncertaintySource: ExtendedForecastResponse['uncertaintySource'] = hasEnsemble
      ? 'open-meteo-ensemble'
      : calibration.calibrated
        ? 'empirical-calibration'
        : 'uncalibrated';

    const uncertaintyMethodNote = hasEnsemble
      ? 'Min–Max bands show real Open-Meteo multi-member ensemble spread. Spread typically widens across 48h and 72h as atmospheric uncertainty grows; forecasts are not guaranteed.'
      : calibration.calibrated
        ? `Bands show empirical historical forecast-vs-observation error (±${calibration.maeHeatIndexC}°C baseline MAE). Longer-range 48h–72h windows carry greater uncertainty.`
        : 'Forecast range bands are currently unavailable (ensemble spread unreachable and insufficient paired calibration history). Uncalibrated estimates — expect wider uncertainty at 48h and 72h.';

    return {
      location: { lat, lng, label },
      horizonHours,
      generatedAtIso: new Date().toISOString(),
      isLive,
      uncertaintySource,
      uncertaintyMethodNote,
      calibration,
      hours,
      dailySummaries,
    };
  } catch (err: any) {
    isLive = false;
    return {
      location: { lat, lng, label },
      horizonHours,
      generatedAtIso: new Date().toISOString(),
      isLive,
      uncertaintySource: 'uncalibrated',
      uncertaintyMethodNote: `Live 72h forecast unavailable (${err?.message || 'network failure'}).`,
      calibration: {
        calibrated: false,
        pairedSamplesCount: 0,
        maeTempC: null,
        maeHeatIndexC: null,
        note: 'Calibration check paused while forecast API is offline.',
      },
      hours: [],
      dailySummaries: [],
    };
  }
}
