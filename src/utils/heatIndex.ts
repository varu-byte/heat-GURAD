import { RiskLevel, RiskThresholds } from '../types';

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  moderate: 32,
  high: 36,
  extreme: 41,
};

/**
 * Calculates Heat Index in Celsius using the standard NOAA Rothfusz regression equation.
 * @param tempC Temperature in Celsius
 * @param humidity Relative Humidity in % (0 - 100)
 * @returns Heat Index in Celsius rounded to 1 decimal place
 */
export function calculateRothfuszHeatIndex(tempC: number, humidity: number): number {
  const T = (tempC * 9) / 5 + 32;
  const RH = Math.max(0, Math.min(100, humidity));

  if (T < 80) {
    const simpleHI = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + RH * 0.094);
    const hiC = ((simpleHI - 32) * 5) / 9;
    return Math.round(hiC * 10) / 10;
  }

  let HI =
    -42.379 +
    2.04901523 * T +
    10.14333127 * RH -
    0.22475541 * T * RH -
    0.00683783 * T * T -
    0.05481717 * RH * RH +
    0.00122874 * T * T * RH +
    0.00085282 * T * RH * RH -
    0.00000199 * T * T * RH * RH;

  if (RH < 13 && T >= 80 && T <= 112) {
    const adj = ((13 - RH) / 4) * Math.sqrt(Math.max(0, (17 - Math.abs(T - 95)) / 17));
    HI -= adj;
  } else if (RH > 85 && T >= 80 && T <= 87) {
    const adj = ((RH - 85) / 10) * ((87 - T) / 5);
    HI += adj;
  }

  const hiC = ((HI - 32) * 5) / 9;
  return Math.round(hiC * 10) / 10;
}

export const heatIndex = calculateRothfuszHeatIndex;

/**
 * Categorize risk across 4 levels:
 * - low (Green): < 32°C
 * - moderate (Yellow): 32°C to < 36°C
 * - high (Orange): 36°C to <= 41°C
 * - extreme (Red): > 41°C
 */
export function getRiskLevel(
  heatIndexValue: number,
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS
): RiskLevel {
  if (heatIndexValue < thresholds.moderate) {
    return 'low';
  } else if (heatIndexValue < thresholds.high) {
    return 'moderate';
  } else if (heatIndexValue <= thresholds.extreme) {
    return 'high';
  } else {
    return 'extreme';
  }
}

export function getRiskRank(risk: RiskLevel): number {
  switch (risk) {
    case 'low':
      return 0;
    case 'moderate':
      return 1;
    case 'high':
      return 2;
    case 'extreme':
      return 3;
  }
}

/**
 * Predict street-level heat index using zone urban morphology.
 */
export function predictStreetLevelHeatIndex(
  baseHeatIndex: number,
  hourNum: number,
  treeCoverPct: number,
  builtUpPct: number
): number {
  let solarFactor = 0;
  if (hourNum >= 6 && hourNum <= 8) {
    solarFactor = 0.2;
  } else if (hourNum >= 9 && hourNum <= 10) {
    solarFactor = 0.6;
  } else if (hourNum >= 11 && hourNum <= 15) {
    solarFactor = 1.0;
  } else if (hourNum >= 16 && hourNum <= 17) {
    solarFactor = 0.5;
  } else if (hourNum >= 18 && hourNum <= 19) {
    solarFactor = 0.15;
  } else {
    solarFactor = 0.05;
  }

  const builtUpThermalDelta = (builtUpPct / 100) * 3.8 * solarFactor;
  const treeCanopyCoolingDelta = (treeCoverPct / 100) * 3.2 * solarFactor;

  const predicted = baseHeatIndex + builtUpThermalDelta - treeCanopyCoolingDelta;
  return Math.round(predicted * 10) / 10;
}

/**
 * Returns advice based on 4-tier risk level and language
 */
export function getHeatAdvice(
  risk: RiskLevel,
  heatIndexValue: number,
  lang: 'en' | 'ta' = 'en'
): { title: string; advice: string; actions: string[] } {
  if (lang === 'ta') {
    if (risk === 'low') {
      return {
        title: 'குறைந்த ஆபத்து (Low Risk)',
        advice: 'வெப்பநிலை பாதுகாப்பானது. இருப்பினும் போதுமான தண்ணீர் குடித்துக் கொண்டு வேலையைத் தொடரவும்.',
        actions: [
          'ஒவ்வொரு 45 நிமிடத்திற்கும் 1 டம்ளர் தண்ணீர் குடிக்கவும்',
          'தலையில் துணி அல்லது தொப்பி அணியவும்',
          'நேரடி வெயிலில் தொடர்ச்சியாக நிற்பதைத் தவிர்க்கவும்',
        ],
      };
    } else if (risk === 'moderate') {
      return {
        title: 'மிதமான வெப்ப எச்சரிக்கை (Moderate Risk)',
        advice: `உணரப்படும் வெப்பம் ${heatIndexValue.toFixed(1)}°C. நிழலில் இடைவேளை எடுத்து தண்ணீர் குடிக்கவும்.`,
        actions: [
          'ஒவ்வொரு 30 நிமிடத்திற்கும் குளிர்ந்த நீர் பருகவும்',
          'வெயில் நேரத்தில் லேசான பருத்தி ஆடை மற்றும் தொப்பி அணியவும்',
          'ஒவ்வொரு மணி நேரமும் 10 நிமிடம் நிழலில் ஓய்வு எடுக்கவும்',
        ],
      };
    } else if (risk === 'high') {
      return {
        title: 'அதிக வெப்ப எச்சரிக்கை (High Risk)',
        advice: 'வெப்ப அழுத்தம் அதிகம்! ஒவ்வொரு மணி நேரமும் நிழலில் 15 நிமிடம் ஓய்வு எடுக்கவும். எலக்ட்ரோலைட் நீர் அவசியம்.',
        actions: [
          'ஒவ்வொரு 20 நிமிடங்களுக்கும் நீர் அல்லது ORS குடிக்கவும்',
          'நிழல் மற்றும் காற்றோட்டமான இடங்களில் ஓய்வெடுக்கவும்',
          'அதிக எடையைத் தூக்கும் கடின வேலைகளைக் குறைக்கவும்',
          'மயக்கம் அல்லது தலைசுற்றல் ஏற்பட்டால் உடனடியாக நிழலில் அமரவும்',
        ],
      };
    } else {
      return {
        title: 'தீவிர வெப்ப அபாயம்! (Extreme Risk)',
        advice: 'ஆபத்தான வெப்ப நிலை! 12:00 முதல் 16:00 வரை கடுமையான வெளிப்புறப் பணிகளை உடனடியாக நிறுத்துங்கள்.',
        actions: [
          'கடுமையான வெயில் வேலையை நிறுத்தி உடனே குளிர் மையத்தை அடையவும்',
          'உடனடியாக குளிர்ந்த நீர், மோர் அல்லது ஓ.ஆர்.எஸ் பருகவும்',
          'தோல் சிவந்து வியர்வை நின்றால் 108 அவசர சிகிச்சையை அழைக்கவும்',
          'சக தொழிலாளர்களின் உடல்நிலையைக் கண்காணிக்கவும்',
        ],
      };
    }
  }

  if (risk === 'low') {
    return {
      title: 'Low Heat Risk',
      advice: 'Normal outdoor work permitted. Maintain regular hydration and wear head protection.',
      actions: [
        'Drink 1 cup of water every 45 minutes',
        'Wear breathable cotton clothing and a wide-brim hat',
        'Keep an eye on hydration during midday sun',
      ],
    };
  } else if (risk === 'moderate') {
    return {
      title: 'Moderate Heat Caution',
      advice: `Heat Index is ${heatIndexValue.toFixed(1)}°C. Increase hydration cadence and schedule shaded micro-breaks.`,
      actions: [
        'Drink cool water every 30 minutes',
        'Take 10-minute shade breaks every hour',
        'Use wet neck cloth or head covering under direct sun',
      ],
    };
  } else if (risk === 'high') {
    return {
      title: 'High Heat Risk — Immediate Caution',
      advice: 'Significant heat strain! Mandatory 15-minute rest breaks every hour in shade. Hydrate with electrolyte fluids.',
      actions: [
        'Drink water or ORS every 20 minutes',
        'Take mandatory 15-min rest in deep shade every hour',
        'Pace strenuous physical labor and avoid prolonged direct sun',
        'Report dizziness, nausea, or cramps immediately to supervisors',
      ],
    };
  } else {
    return {
      title: 'Extreme Heat Danger — Stop Heavy Work!',
      advice: 'Dangerous heat stroke threshold! Halt strenuous outdoor manual labor between 12:00 and 16:00. Move to cooling shelters.',
      actions: [
        'GCC Directive: Cease heavy manual labor during peak midday hours',
        'Move immediately to nearest cooling center or Amma water station',
        'Apply cool water to neck, face, and wrists; drink cool water with electrolytes',
        'If confusion, cessation of sweating, or fainting occurs, call 108 emergency immediately',
      ],
    };
  }
}

/**
 * Color and styling classes for the 4 Rothfusz risk levels:
 * Green for LOW, Yellow for MODERATE, Orange for HIGH, Red for EXTREME.
 */
export const RISK_CONFIG: Record<
  RiskLevel,
  {
    color: string;
    labelEn: string;
    labelTa: string;
    bgClass: string;
    badgeClass: string;
    ringClass: string;
    barColor: string;
    description: string;
  }
> = {
  low: {
    color: '#22c55e', // Green
    labelEn: 'LOW',
    labelTa: 'குறைவு (LOW)',
    bgClass: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-800 dark:text-emerald-300',
    badgeClass: 'bg-emerald-600 text-white',
    ringClass: 'ring-emerald-500',
    barColor: '#22c55e',
    description: 'Below 32°C — Routine monitoring & regular hydration',
  },
  moderate: {
    color: '#eab308', // Yellow
    labelEn: 'MODERATE',
    labelTa: 'மிதமான (MODERATE)',
    bgClass: 'bg-yellow-500/15 border-yellow-500/40 text-yellow-800 dark:text-yellow-300',
    badgeClass: 'bg-yellow-400 text-stone-950 font-bold',
    ringClass: 'ring-yellow-400',
    barColor: '#eab308',
    description: '32°C to 36°C — Advisory warning & shaded micro-breaks',
  },
  high: {
    color: '#f97316', // Orange
    labelEn: 'HIGH',
    labelTa: 'அதிகம் (HIGH)',
    bgClass: 'bg-orange-500/15 border-orange-500/40 text-orange-800 dark:text-orange-300',
    badgeClass: 'bg-orange-500 text-white font-bold',
    ringClass: 'ring-orange-500',
    barColor: '#f97316',
    description: '36°C to 41°C — Mandatory 15m rest/hr, Push & SMS alerts',
  },
  extreme: {
    color: '#ef4444', // Red
    labelEn: 'EXTREME',
    labelTa: 'தீவிரம் (EXTREME)',
    bgClass: 'bg-rose-500/20 border-rose-500/40 text-rose-800 dark:text-rose-200',
    badgeClass: 'bg-rose-600 text-white animate-pulse',
    ringClass: 'ring-rose-600',
    barColor: '#ef4444',
    description: 'Above 41°C — Critical emergency alert, stop heavy labor',
  },
};
