import * as SunCalc from 'suncalc';

const CHENNAI_LAT = 13.0418;
const CHENNAI_LNG = 80.2341;

const sunCalcApi: {
  getPosition: (date: Date, lat: number, lng: number) => { altitude: number; azimuth: number };
} = ((SunCalc as any).default ?? SunCalc) as any;

export function toLocalDateTimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Returns the solar altitude in degrees for Chennai at a given timestamp.
 * suncalc@2.1.4 returns degrees directly.
 */
export function getChennaiSunAltitudeDeg(date: Date, lat = CHENNAI_LAT, lng = CHENNAI_LNG): number {
  try {
    const pos = sunCalcApi.getPosition(date, lat, lng);
    return Number.isFinite(pos?.altitude) ? pos.altitude : 0;
  } catch {
    return 0;
  }
}

/**
 * Computes the next upcoming 12:30 PM IST (07:00 UTC) peak-sun moment in Chennai.
 * Anchoring to 07:00 UTC guarantees midday sun in Chennai even if the user's browser
 * is set to a non-IST timezone (e.g. UTC or US Pacific).
 */
export function getNextChennaiMiddaySunDate(from = new Date()): Date {
  const candidate = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 7, 0, 0, 0)
  );
  if (candidate.getTime() <= from.getTime() + 15 * 60 * 1000) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

/**
 * Formats a Date in India Standard Time (Asia/Kolkata) for clear daytime preview labels.
 */
export function formatChennaiTimeLabel(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

/**
 * Returns the initial departure datetime input value.
 * If it is currently nighttime / very low sun (< 5° solar altitude) in Chennai,
 * automatically switches to the next 12:30 PM IST peak-sun window so users can
 * immediately inspect meaningful building & tree shade comparisons.
 */
export function getInitialSunDepartureState(): {
  departureInput: string;
  isAutoDaytimePreview: boolean;
  previewDate: Date;
  currentAltitudeDeg: number;
} {
  const now = new Date();
  const currentAltitudeDeg = Math.round(getChennaiSunAltitudeDeg(now) * 10) / 10;
  if (currentAltitudeDeg < 5) {
    const midday = getNextChennaiMiddaySunDate(now);
    return {
      departureInput: toLocalDateTimeInputValue(midday),
      isAutoDaytimePreview: true,
      previewDate: midday,
      currentAltitudeDeg,
    };
  }
  return {
    departureInput: toLocalDateTimeInputValue(now),
    isAutoDaytimePreview: false,
    previewDate: now,
    currentAltitudeDeg,
  };
}
