import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  getReadings as getWeatherReadings,
  getCurrentReading as getWeatherCurrentReading,
  fetchLiveWeatherData,
  getChennaiCurrentHour,
  calculateRothfusz,
  getRiskLevel,
  getWeatherStatus,
} from './services/weather.ts';
import {
  deleteMonitoredLocation,
  deleteRecipient,
  evaluateLocationHeatTransition,
  getAlertHistory,
  getAlertStates,
  getEscalationDashboardStats,
  getGatewayDiagnostics,
  getMonitoredLocations,
  getNotificationSettings,
  getRecipients,
  getSmsDeliveries,
  getTargetedRecipients,
  registerDeviceToken,
  retryFailedSmsDeliveries,
  runScheduledHeatMonitor,
  sendLiveDemoSms,
  startBackgroundScheduler,
  updateNotificationSettings,
  upsertMonitoredLocation,
  upsertRecipient,
} from './services/escalationEngine.ts';
import { generateAiEscalationAnalysis } from './services/aiAdvisor.ts';
import { estimateAreaShade } from './services/shadeEngine.ts';
import { computeCoolRoutes } from './services/coolRouteEngine.ts';
import { getExtendedForecastWithUncertainty } from './services/forecastService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIREBASE_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf-8')
);
const FIREBASE_PROJECT_ID: string = FIREBASE_CONFIG.projectId;
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);
const BOOTSTRAPPED_ADMIN_EMAIL = 'varunsaiprabhu14@gmail.com';

interface VerifiedFirebaseUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

async function verifyBearerUser(req: Request): Promise<VerifiedFirebaseUser | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      audience: FIREBASE_PROJECT_ID,
    });
    const uid = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    const emailVerified = Boolean(payload.email_verified);
    if (!uid || !emailVerified) return null;
    return { uid, email, emailVerified };
  } catch {
    return null;
  }
}

async function requireVerifiedUser(req: Request, res: Response, next: NextFunction) {
  const user = await verifyBearerUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Authentication required (valid verified Firebase token missing).' });
  }
  (req as any).firebaseUser = user;
  next();
}

async function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const user = await verifyBearerUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Admin sign-in required to modify settings or trigger operations.' });
  }
  if (user.email.toLowerCase() !== BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase()) {
    return res.status(403).json({ error: 'Administrator privileges required.' });
  }
  (req as any).firebaseUser = user;
  next();
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

app.use(express.json());

// ==========================================
// DATA STRUCTURES & DATABASE SEEDS
// ==========================================

export interface ZoneData {
  id: string;
  name: string;
  name_ta: string;
  ward_no: number;
  lat: number;
  lng: number;
  tree_cover_pct: number;
  built_up_pct: number;
  worker_density: number; // 0 - 100
  description: string;
  description_ta: string;
}

const ZONES: ZoneData[] = [
  {
    id: 't-nagar',
    name: 'T. Nagar',
    name_ta: 'தி. நகர்',
    ward_no: 141,
    lat: 13.0418,
    lng: 80.2341,
    tree_cover_pct: 12,
    built_up_pct: 88,
    worker_density: 95,
    description: 'High commercial density, Ranganathan St vendors, retail assistants, auto drivers.',
    description_ta: 'அதிக வணிக அடர்த்தி, ரங்கநாதன் தெரு விற்பனையாளர்கள், ஆட்டோ ஓட்டுநர்கள்.',
  },
  {
    id: 'koyambedu',
    name: 'Koyambedu',
    name_ta: 'கோயம்பேடு',
    ward_no: 127,
    lat: 13.0694,
    lng: 80.1948,
    tree_cover_pct: 8,
    built_up_pct: 92,
    worker_density: 98,
    description: 'Asia’s largest wholesale perishable market. Loaders, cart pullers, truck handlers.',
    description_ta: 'ஆசியாவின் மிகப்பெரிய மொத்த சந்தை. சுமை தூக்கும் தொழிலாளர்கள், லாரி தொழிலாளர்கள்.',
  },
  {
    id: 'guindy',
    name: 'Guindy',
    name_ta: 'கிண்டி',
    ward_no: 168,
    lat: 13.0067,
    lng: 80.2025,
    tree_cover_pct: 18,
    built_up_pct: 82,
    worker_density: 85,
    description: 'Industrial estate & Kathipara transit junction. Heavy vehicle traffic, outdoor loaders.',
    description_ta: 'தொழிற்பேட்டை & கத்திப்பாரா சந்திப்பு. கனரக போக்குவரத்து, தொழிற்சாலை தொழிலாளர்கள்.',
  },
  {
    id: 'marina',
    name: 'Marina Beach',
    name_ta: 'மெரினா கடற்கரை',
    ward_no: 111,
    lat: 13.0500,
    lng: 80.2824,
    tree_cover_pct: 6,
    built_up_pct: 75,
    worker_density: 88,
    description: 'Coastal open sand, street food vendors, boat repairers, sanitation crews.',
    description_ta: 'கடற்கரை திறந்தவெளி மணல் பரப்பு, சிறுவியாபாரிகள், படகு பழுதுபார்ப்போர், தூய்மைப் பணியாளர்கள்.',
  },
  {
    id: 'ennore',
    name: 'Ennore',
    name_ta: 'எண்ணூர்',
    ward_no: 1,
    lat: 13.2030,
    lng: 80.3230,
    tree_cover_pct: 5,
    built_up_pct: 95,
    worker_density: 89,
    description: 'Thermal power plants, coal yards, and port container yards. High ambient industrial heat.',
    description_ta: 'அனல்மின் நிலையங்கள், நிலக்கரி சேமிப்பு கிடங்கு, துறைமுக கொள்கலன் முனையம்.',
  },
  {
    id: 'velachery',
    name: 'Velachery',
    name_ta: 'வேளச்சேரி',
    ward_no: 178,
    lat: 12.9815,
    lng: 80.2180,
    tree_cover_pct: 15,
    built_up_pct: 85,
    worker_density: 78,
    description: 'Bypass commercial corridor, quick commerce delivery riders, construction laborers.',
    description_ta: 'பைபாஸ் வணிக வளாக பகுதி, உணவு டெலிவரி ஊழியர்கள், கட்டுமான தொழிலாளர்கள்.',
  },
  {
    id: 'tambaram',
    name: 'Tambaram',
    name_ta: 'தாம்பரம்',
    ward_no: 200,
    lat: 12.9249,
    lng: 80.1000,
    tree_cover_pct: 22,
    built_up_pct: 78,
    worker_density: 82,
    description: 'Major railway junction, bus terminus, Sanatorium wholesale market outdoor staff.',
    description_ta: 'தாம்பரம் ரயில்வே சந்திப்பு, பேருந்து நிலையம், சானடோரியம் சந்தை தொழிலாளர்கள்.',
  },
  {
    id: 'anna-nagar',
    name: 'Anna Nagar',
    name_ta: 'அண்ணா நகர்',
    ward_no: 100,
    lat: 13.0850,
    lng: 80.2101,
    tree_cover_pct: 26,
    built_up_pct: 74,
    worker_density: 72,
    description: 'Tree-lined avenue grid, delivery partners, gardening and maintenance personnel.',
    description_ta: 'மரங்கள் நிறைந்த அவென்யூ, டெலிவரி ஊழியர்கள், பூங்கா மற்றும் நகராட்சி பணியாளர்கள்.',
  },
  {
    id: 'adyar',
    name: 'Adyar',
    name_ta: 'அடையாறு',
    ward_no: 173,
    lat: 13.0012,
    lng: 80.2565,
    tree_cover_pct: 28,
    built_up_pct: 72,
    worker_density: 65,
    description: 'Estuary breeze corridor, river bank sanitation staff, traffic wardens.',
    description_ta: 'அடையாறு முகத்துவார பகுதி, தூய்மைப் பணியாளர்கள், போக்குவரத்து காவலர்கள்.',
  },
  {
    id: 'perambur',
    name: 'Perambur',
    name_ta: 'பெரம்பூர்',
    ward_no: 70,
    lat: 13.1075,
    lng: 80.2334,
    tree_cover_pct: 14,
    built_up_pct: 86,
    worker_density: 84,
    description: 'Loco works, dense railway yard, auto mechanics and roadside welders.',
    description_ta: 'லோகோ பணிமனை, ரயில்வே யார்டு, மெக்கானிக் மற்றும் பட்டறை தொழிலாளர்கள்.',
  },
];

// Static Relief Points loader from data/relief-points.json (developers edit file directly; read-only)
function loadStaticReliefPoints(): Array<{
  id: string;
  zone_id: string;
  name: string;
  name_ta: string;
  type: 'shade' | 'water' | 'cooling';
  lat: number;
  lng: number;
  address: string;
  address_ta: string;
  capacity: number;
  verified: boolean;
  facilities: string[];
}> {
  try {
    const filePath = path.join(__dirname, 'data', 'relief-points.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load static data/relief-points.json:', err);
    return [];
  }
}

// Sensors deployed in Chennai
let sensors = [
  {
    id: 'ESP32-KOY-01',
    zone_id: 'koyambedu',
    zone_name: 'Koyambedu',
    name: 'Koyambedu Gate 3 Industrial DHT22',
    location_desc: 'Flower Market Gate 3 Mast, 2.5m above asphalt',
    location_desc_ta: 'பூ சந்தை வாயில் 3 கம்பம், தரைக்கு மேல் 2.5 மீ',
    last_reading_time: new Date().toISOString(),
    last_temp: 36.8,
    last_humidity: 68,
    last_heat_index: 46.2,
    status: 'online' as const,
    battery_pct: 94,
    firmware_version: 'v2.4.1-chennai-dht22',
  },
  {
    id: 'ESP32-TNG-02',
    zone_id: 't-nagar',
    zone_name: 'T. Nagar',
    name: 'Usman Road Flyover Base Sensor',
    location_desc: 'Ranganathan St intersection lamppost',
    location_desc_ta: 'ரங்கநாதன் தெரு சந்திப்பு விளக்குக் கம்பம்',
    last_reading_time: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    last_temp: 35.5,
    last_humidity: 65,
    last_heat_index: 44.1,
    status: 'online' as const,
    battery_pct: 88,
    firmware_version: 'v2.4.1-chennai-dht22',
  },
  {
    id: 'ESP32-ENR-03',
    zone_id: 'ennore',
    zone_name: 'Ennore',
    name: 'Ennore Port Express Highway Hub',
    location_desc: 'Coal yard boundary perimeter station',
    location_desc_ta: 'நிலக்கரி யார்டு எல்லை நிலைய கண்காணிப்பு',
    last_reading_time: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
    last_temp: 37.4,
    last_humidity: 62,
    last_heat_index: 47.0,
    status: 'online' as const,
    battery_pct: 91,
    firmware_version: 'v2.4.1-chennai-dht22',
  },
  {
    id: 'ESP32-MAR-04',
    zone_id: 'marina',
    zone_name: 'Marina Beach',
    name: 'Marina Promenade Coastal Monitor',
    location_desc: 'Lifeguard tower #4 beach level',
    location_desc_ta: 'உயிர்காக்கும் கோபுரம் 4 கடற்கரை மட்டம்',
    last_reading_time: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    last_temp: 34.2,
    last_humidity: 78,
    last_heat_index: 45.8,
    status: 'online' as const,
    battery_pct: 82,
    firmware_version: 'v2.4.1-chennai-dht22',
  },
  {
    id: 'ESP32-GND-05',
    zone_id: 'guindy',
    zone_name: 'Guindy',
    name: 'Guindy Industrial SIDCO Mast',
    location_desc: 'Heavy cargo gate traffic island',
    location_desc_ta: 'கனரக சரக்கு வாயில் போக்குவரத்து தீவு',
    last_reading_time: new Date(Date.now() - 22 * 60 * 1000).toISOString(),
    last_temp: 35.0,
    last_humidity: 64,
    last_heat_index: 42.6,
    status: 'offline' as const, // > 15m ago
    battery_pct: 42,
    firmware_version: 'v2.3.0-chennai-dht22',
  },
];

// Readings table: logs historical readings from sensors or API
let readingsTable: Array<{
  id: string;
  zone_id: string;
  time: string;
  temp: number;
  humidity: number;
  heat_index: number;
  source: 'api' | 'sensor';
  sensor_id?: string;
}> = [];

// Seed recent readings for sensor-enabled zones
sensors.forEach((s) => {
  readingsTable.push({
    id: `read-${s.id}-${Date.now()}`,
    zone_id: s.zone_id,
    time: s.last_reading_time,
    temp: s.last_temp,
    humidity: s.last_humidity,
    heat_index: s.last_heat_index,
    source: 'sensor',
    sensor_id: s.id,
  });
});

// GCC Alerts
let alerts = [
  {
    id: 'alert-1',
    timestamp: new Date().toISOString(),
    zone_id: 'koyambedu',
    zone_name: 'Koyambedu & Ennore',
    level: 'extreme' as const,
    heat_index: 46.2,
    message: 'RED ALERT: Heat Index exceeded 45°C. Mandatory 15-minute rest enforced. Move to shaded cooling shelters.',
    message_ta: 'சிவப்பு எச்சரிக்கை: வெப்பக் குறியீடு 45°C கடந்தது. கட்டாய 15 நிமிட ஓய்வு அமல். குளிர் மையங்களுக்கு செல்லவும்.',
    sent_by: 'GCC Disaster Management Cell',
  },
  {
    id: 'alert-2',
    timestamp: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    zone_id: 'all',
    zone_name: 'All Chennai Zones',
    level: 'high' as const,
    heat_index: 38.5,
    message: 'HIGH HEAT ADVISORY: Coastal humidity pushing thermal stress. Free ORS and chilled buttermilk available at Amma water kiosks.',
    message_ta: 'உயர் வெப்ப ஆலோசனை: கடலோர ஈரப்பதம் வெப்ப அழுத்தத்தை அதிகரிக்கிறது. அம்மா குடிநீர் நிலையங்களில் இலவச மோர் மற்றும் ORS வழங்கப்படுகிறது.',
    sent_by: 'GCC Chief Health Officer',
  },
];

// Worker break logs
let breakLogs = [
  {
    id: 'brk-101',
    timestamp: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
    worker_id: 'WKR-9481',
    zone_id: 'koyambedu',
    zone_name: 'Koyambedu',
    duration_mins: 15,
    note: 'Shade rest + ORS drink at Flower Gate 3',
  },
  {
    id: 'brk-102',
    timestamp: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    worker_id: 'WKR-2309',
    zone_id: 't-nagar',
    zone_name: 'T. Nagar',
    duration_mins: 20,
    note: 'Mist tent break on Usman Road',
  },
  {
    id: 'brk-103',
    timestamp: new Date(Date.now() - 80 * 60 * 1000).toISOString(),
    worker_id: 'WKR-5512',
    zone_id: 'marina',
    zone_name: 'Marina Beach',
    duration_mins: 15,
    note: 'Hydration under Gandhi Statue canopy',
  },
];

// Midday rest rule configuration
let middayRestRule = {
  enabled: true,
  start_hour: '12:00',
  end_hour: '16:00',
  threshold_heat_index: 41,
  mandatory_rest_mins_per_hour: 15,
  prohibited_activities: [
    'Roofing & open iron girder handling',
    'Road tarring & asphalt laying',
    'Direct sunlight cart pulling & heavy manual loading',
    'Outdoor wall plastering & masonry above ground level',
  ],
  prohibited_activities_ta: [
    'கூரை அமைத்தல் மற்றும் இரும்புப் பொருட்கள் கையாளுதல்',
    'சாலை தார் போடுதல்',
    'நேரடி வெயிலில் சுமை இழுத்தல் மற்றும் ஏற்றுதல்',
    'திறந்தவெளி வெளிப்புறக் கட்டுமானப் பணிகள்',
  ],
  last_updated: new Date().toISOString(),
  updated_by: 'GCC Commissioner Office',
};

// ==========================================
// ROTHFLUSZ HEAT INDEX & ENGINE
// ==========================================

function predictMicroclimate(
  baseHI: number,
  hourNum: number,
  treeCoverPct: number,
  builtUpPct: number
): number {
  let solarFactor = 0.1;
  if (hourNum >= 6 && hourNum <= 8) solarFactor = 0.25;
  else if (hourNum >= 9 && hourNum <= 10) solarFactor = 0.65;
  else if (hourNum >= 11 && hourNum <= 15) solarFactor = 1.0;
  else if (hourNum >= 16 && hourNum <= 17) solarFactor = 0.55;
  else if (hourNum >= 18 && hourNum <= 19) solarFactor = 0.2;

  const builtDelta = (builtUpPct / 100) * 3.8 * solarFactor;
  const treeCooling = (treeCoverPct / 100) * 3.2 * solarFactor;

  return Math.round((baseHI + builtDelta - treeCooling) * 10) / 10;
}

// ==========================================
// ADAPTER: getReadings(zoneId)
// Single unified access point:
// 1. Fetches live Open-Meteo data via services/weather.ts (cached 15 mins, Live/Offline badge)
// 2. Checks active sensors which OVERRIDE the API when a sensor exists for that zone
// ==========================================
async function getReadings(zoneId: string) {
  const zone = ZONES.find((z) => z.id === zoneId);
  if (!zone) throw new Error(`Zone ${zoneId} not found`);

  const now = Date.now();

  // 1. Check if a live sensor was dynamically ingested for this zone (< 30 min old)
  const recentSensor = sensors.find(
    (s) => (s as any).is_live_ingested && s.zone_id === zoneId && now - new Date(s.last_reading_time).getTime() < 30 * 60 * 1000
  );

  // 2. Get live real-time reading and 24-hour readings for today from weather service
  const [liveReading, hourlyFromWeather] = await Promise.all([
    getWeatherCurrentReading(zoneId),
    getWeatherReadings(zoneId),
  ]);
  const weatherStatus = getWeatherStatus();
  const currentHour = getChennaiCurrentHour();

  // Base reading from live Open-Meteo observation
  let currentTemp = liveReading.temp;
  let currentHum = liveReading.humidity;
  let source: 'api' | 'sensor' = 'api';
  let sensorId: string | undefined = undefined;

  // SENSOR OVERRIDE RULE: Only when an actual sensor packet is received, it overrides the API reading
  if (recentSensor) {
    currentTemp = recentSensor.last_temp;
    currentHum = recentSensor.last_humidity;
    source = 'sensor';
    sensorId = recentSensor.id;
  }

  // Calculate Rothfusz Heat Index
  const currentHI = calculateRothfusz(currentTemp, currentHum);
  const currentRisk = getRiskLevel(currentHI);
  const predictedHI = predictMicroclimate(
    currentHI,
    currentHour,
    zone.tree_cover_pct,
    zone.built_up_pct
  );

  // Hourly breakdown for 06:00 to 22:00
  const hourlyReadings = [];
  const saferHours: string[] = [];
  const avoidHours: string[] = [];

  for (let h = 6; h <= 22; h++) {
    const item = hourlyFromWeather[h] || hourlyFromWeather[0];
    const hourStr = item ? item.hour : `${h.toString().padStart(2, '0')}:00`;
    let hTemp = item ? item.temp : currentTemp;
    let hHum = item ? item.humidity : currentHum;

    // If current hour has live sensor override
    if (h === currentHour && recentSensor) {
      hTemp = recentSensor.last_temp;
      hHum = recentSensor.last_humidity;
    }

    const hi = calculateRothfusz(hTemp, hHum);
    const predHI = predictMicroclimate(hi, h, zone.tree_cover_pct, zone.built_up_pct);
    const risk = getRiskLevel(hi);

    const isSafer = risk === 'low';
    const isAvoid = risk === 'extreme' || (risk === 'high' && (h >= 11 && h <= 16));

    if (isSafer) saferHours.push(hourStr);
    if (isAvoid) avoidHours.push(hourStr);

    hourlyReadings.push({
      hour: hourStr,
      hour_num: h,
      temp: hTemp,
      humidity: hHum,
      heat_index: hi,
      feels_like: hi,
      predicted_heat_index: predHI,
      risk,
      is_safer: isSafer,
      is_avoid: isAvoid,
    });
  }

  const zoneReliefCount = loadStaticReliefPoints().filter((rp) => rp.zone_id === zoneId).length;

  return {
    ...zone,
    is_live: weatherStatus.isLive,
    connection_status: weatherStatus.isLive ? 'live' : 'offline',
    badge: weatherStatus.badge,
    last_updated: weatherStatus.lastUpdatedTimeStr || 'Just now',
    current_reading: {
      id: `reading-${zoneId}-${now}`,
      zone_id: zoneId,
      time: new Date().toISOString(),
      temp: currentTemp,
      humidity: currentHum,
      heat_index: currentHI,
      feels_like: currentHI,
      predicted_heat_index: predictedHI,
      risk: currentRisk,
      source,
      sensor_id: sensorId,
      is_live: weatherStatus.isLive,
      connection_status: weatherStatus.isLive ? 'live' : 'offline',
      badge: weatherStatus.badge,
      advice:
        currentRisk === 'extreme'
          ? 'Dangerous heat stress! Stop heavy outdoor labor. Head to cooling shelter immediately.'
          : currentRisk === 'high'
            ? 'High heat risk. Take mandatory 15-min shaded rest breaks every hour and drink electrolyte water.'
            : currentRisk === 'moderate'
              ? 'Moderate heat risk. Increase hydration every 30 mins and take 10-min shade breaks.'
              : 'Low heat risk. Normal outdoor work permitted with regular hydration.',
      advice_ta:
        currentRisk === 'extreme'
          ? 'ஆபத்தான வெப்ப நிலை! வெளிப்புற வேலைகளை நிறுத்தி உடனே குளிர் மையத்தை அடையவும்.'
          : currentRisk === 'high'
            ? 'அதிக வெப்ப அபாயம். மணிதோறும் 15 நிமிடம் நிழலில் ஓய்வெடுத்து நீர் பருகவும்.'
            : currentRisk === 'moderate'
              ? 'மிதமான வெப்ப எச்சரிக்கை. ஒவ்வொரு 30 நிமிடத்திற்கும் நீர் பருகி நிழலில் ஓய்வெடுக்கவும்.'
              : 'பாதுகாப்பான நிலை. போதுமான தண்ணீர் குடித்துக் கொண்டு வேலையைத் தொடரவும்.',
    },
    hourly_readings: hourlyReadings,
    safer_hours: saferHours,
    avoid_hours: avoidHours,
    relief_points_count: zoneReliefCount,
    active_sensor: recentSensor,
  };
}

// ==========================================
// REST API ENDPOINTS
// ==========================================

// 1. GET /api/zones: overview of all 10 zones with heat index & risk
app.get('/api/zones', async (_req: Request, res: Response) => {
  try {
    // Warm shared 15-min TTL cache once so all 10 zones reuse one deduplicated Open-Meteo response
    await fetchLiveWeatherData(false);
    const results = await Promise.all(ZONES.map((z) => getReadings(z.id)));
    res.json(results);
  } catch (err: any) {
    res.status(503).json({ error: 'Failed to fetch zone readings', details: err.message });
  }
});

// 2. GET /api/zones/:id: detailed data for a single zone
app.get('/api/zones/:id', async (req: Request, res: Response) => {
  try {
    const data = await getReadings(req.params.id);
    res.json(data);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// 3. POST /api/sensor: ESP32 + DHT22 endpoint
// Format: { sensor_id, temp, humidity, timestamp }
app.post('/api/sensor', (req: Request, res: Response) => {
  const { sensor_id, temp, humidity, timestamp } = req.body;

  if (!sensor_id || temp === undefined || humidity === undefined) {
    return res.status(400).json({
      error: 'Missing required parameters. Required: { sensor_id, temp, humidity }',
    });
  }

  const numericTemp = parseFloat(temp);
  const numericHum = parseFloat(humidity);

  if (isNaN(numericTemp) || isNaN(numericHum)) {
    return res.status(400).json({ error: 'Invalid numeric temp or humidity values' });
  }

  const hi = calculateRothfusz(numericTemp, numericHum);
  const readingTime = timestamp || new Date().toISOString();

  // Find or create sensor record
  let sensor = sensors.find((s) => s.id === sensor_id);
  if (sensor) {
    sensor.last_reading_time = readingTime;
    sensor.last_temp = numericTemp;
    sensor.last_humidity = numericHum;
    sensor.last_heat_index = hi;
    sensor.status = 'online';
    (sensor as any).is_live_ingested = true;
  } else {
    // New sensor auto-registration default
    sensor = {
      id: sensor_id,
      zone_id: 'koyambedu', // default assign if unknown
      zone_name: 'Koyambedu',
      name: `ESP32 Station ${sensor_id}`,
      location_desc: 'Field deployed unit',
      location_desc_ta: 'களத்தில் பொருத்தப்பட்ட சாதனம்',
      last_reading_time: readingTime,
      last_temp: numericTemp,
      last_humidity: numericHum,
      last_heat_index: hi,
      status: 'online',
      battery_pct: 100,
      firmware_version: 'v2.4.1-esp32-dht22',
    };
    (sensor as any).is_live_ingested = true;
    sensors.push(sensor);
  }

  // Append to readings table
  const newReading = {
    id: `read-${sensor_id}-${Date.now()}`,
    zone_id: sensor.zone_id,
    time: readingTime,
    temp: numericTemp,
    humidity: numericHum,
    heat_index: hi,
    source: 'sensor' as const,
    sensor_id,
  };
  readingsTable.unshift(newReading);
  if (readingsTable.length > 500) readingsTable.pop();

  // If heat index is extreme (> 41°C), auto-log an alert if none logged in last 10 minutes
  if (hi > 41) {
    const recentAlert = alerts.find(
      (a) => a.zone_id === sensor!.zone_id && Date.now() - new Date(a.timestamp).getTime() < 10 * 60 * 1000
    );
    if (!recentAlert) {
      alerts.unshift({
        id: `alert-auto-${Date.now()}`,
        timestamp: new Date().toISOString(),
        zone_id: sensor.zone_id,
        zone_name: sensor.zone_name,
        level: 'extreme',
        heat_index: hi,
        message: `AUTOMATED SENSOR ALERT: ${sensor.name} measured extreme heat index of ${hi}°C. Immediate rest required.`,
        message_ta: `தானியங்கி சென்சார் எச்சரிக்கை: ${sensor.name} ${hi}°C தீவிர வெப்பத்தை பதிவு செய்துள்ளது. உடனடி ஓய்வு தேவை.`,
        sent_by: `ESP32 Station ${sensor.id}`,
      });
    }
  }

  return res.status(201).json({
    status: 'success',
    message: 'Sensor reading ingested and applied to zone microclimate model',
    reading: newReading,
    heat_index: hi,
    risk: getRiskLevel(hi),
  });
});

// 4. GET /api/relief-points: read-only static relief spots from data/relief-points.json
app.get('/api/relief-points', (req: Request, res: Response) => {
  const { zone_id, type } = req.query;
  let list = loadStaticReliefPoints();
  if (zone_id) {
    list = list.filter((rp) => rp.zone_id === zone_id);
  }
  if (type) {
    list = list.filter((rp) => rp.type === type);
  }
  res.json(list);
});

// 5. GET /api/alerts: alerts list (read-only)
app.get('/api/alerts', (_req: Request, res: Response) => {
  res.json(alerts);
});

// 6. GET /api/breaks: break logs
app.get('/api/breaks', (_req: Request, res: Response) => {
  const today = new Date().toISOString().split('T')[0];
  const todayBreaks = breakLogs.filter((b) => b.timestamp.startsWith(today));
  res.json({
    total_today: todayBreaks.length,
    recent_logs: breakLogs.slice(0, 50),
  });
});

// 7. POST /api/breaks: "I took a break" counter logging (Worker App)
app.post('/api/breaks', (req: Request, res: Response) => {
  const { worker_id, zone_id, zone_name, duration_mins, note } = req.body;

  const newBreak = {
    id: `brk-${Date.now()}`,
    timestamp: new Date().toISOString(),
    worker_id: worker_id || `WKR-${Math.floor(1000 + Math.random() * 9000)}`,
    zone_id: zone_id || 'koyambedu',
    zone_name: zone_name || 'Chennai Zone',
    duration_mins: duration_mins || 15,
    note: note || 'Shaded Rest & Hydration',
  };

  breakLogs.unshift(newBreak);
  res.status(201).json({ status: 'success', break_log: newBreak, total_today: breakLogs.length });
});

// 8. GET /api/compliance: read-only midday rest guidance
app.get('/api/compliance', (_req: Request, res: Response) => {
  res.json({
    rule: middayRestRule,
    total_breaks_logged_today: breakLogs.length,
    active_alerts_count: alerts.length,
  });
});

// 13. GET /api/sensors: sensors list
app.get('/api/sensors', (_req: Request, res: Response) => {
  const now = Date.now();
  // Update status based on last reading
  sensors.forEach((s) => {
    const diffMins = (now - new Date(s.last_reading_time).getTime()) / (60 * 1000);
    s.status = diffMins < 15 ? 'online' : 'offline';
  });
  res.json(sensors);
});

// 14. GET /api/export/compliance.csv: CSV export for authorities
app.get('/api/export/compliance.csv', (_req: Request, res: Response) => {
  let csv = 'Break_ID,Timestamp,Worker_ID,Zone_Name,Duration_Minutes,Notes\n';
  breakLogs.forEach((b) => {
    csv += `"${b.id}","${b.timestamp}","${b.worker_id}","${b.zone_name}","${b.duration_mins}","${b.note || ''}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="chennai_heat_compliance_log.csv"');
  res.send(csv);
});

// 15. GET /chennai-heat-guard.zip: Download complete local project ZIP archive
app.get('/chennai-heat-guard.zip', (_req: Request, res: Response) => {
  const zipPath = path.join(__dirname, 'chennai-heat-guard.zip');
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Project ZIP archive not found' });
  }
  res.download(zipPath, 'chennai-heat-guard.zip');
});

// ==========================================
// AUTOMATIC ALERT ESCALATION SYSTEM ROUTES
// ==========================================

// Overview: Non-PII summary, settings, locations, states, history, and masked delivery metrics
app.get('/api/escalation/overview', (_req: Request, res: Response) => {
  res.json({
    stats: getEscalationDashboardStats(),
    settings: getNotificationSettings(),
    locations: getMonitoredLocations(),
    states: getAlertStates(),
    history: getAlertHistory(true),
    smsDeliveries: getSmsDeliveries(),
    recipientsMasked: getRecipients(true),
    diagnostics: getGatewayDiagnostics(),
  });
});

// Admin-only full recipients list (with phone numbers & management controls)
app.get('/api/escalation/recipients', requireAdminAuth, (_req: Request, res: Response) => {
  res.json(getRecipients(false));
});

// Admin-only recipient create/update
app.post('/api/escalation/recipients', requireAdminAuth, (req: Request, res: Response) => {
  const { id, ownerUid, name, phone, locationIds, pushEnabled, smsEnabled, consentGranted, active, minRiskLevel } = req.body || {};
  if (!name || typeof name !== 'string' || !Array.isArray(locationIds)) {
    return res.status(400).json({ error: 'Recipient name and locationIds array are required.' });
  }
  const saved = upsertRecipient({
    id: id || `rec-${Date.now()}`,
    ownerUid: ownerUid || (req as any).firebaseUser.uid,
    name,
    phone: String(phone || ''),
    locationIds,
    pushEnabled: Boolean(pushEnabled),
    smsEnabled: Boolean(smsEnabled),
    consentGranted: Boolean(consentGranted),
    active: active !== false,
    minRiskLevel: minRiskLevel || 'high',
  });
  res.status(201).json(saved);
});

// Verified worker self-subscription (strictly scoped to caller's own UID)
app.post('/api/escalation/subscribe', requireVerifiedUser, (req: Request, res: Response) => {
  const caller = (req as any).firebaseUser as VerifiedFirebaseUser;
  const { name, phone, locationIds, pushEnabled, smsEnabled, consentGranted, active, minRiskLevel } = req.body || {};
  if (!consentGranted) {
    return res.status(400).json({ error: 'Explicit opt-in consent is required before enabling alerts.' });
  }
  if (!Array.isArray(locationIds) || locationIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one subscribed location.' });
  }
  const saved = upsertRecipient({
    id: `worker-${caller.uid}`,
    ownerUid: caller.uid,
    name: String(name || caller.email.split('@')[0] || 'HeatGuard Subscriber'),
    phone: String(phone || ''),
    locationIds,
    pushEnabled: Boolean(pushEnabled),
    smsEnabled: Boolean(smsEnabled),
    consentGranted: true,
    consentTimestamp: new Date().toISOString(),
    active: active !== false,
    minRiskLevel: minRiskLevel || 'high',
  });
  res.status(201).json(saved);
});

app.delete('/api/escalation/recipients/:id', requireAdminAuth, (req: Request, res: Response) => {
  const deleted = deleteRecipient(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Recipient not found.' });
  res.json({ deleted: true });
});

// Device FCM / Push token registration
app.post('/api/escalation/device-tokens', (req: Request, res: Response) => {
  const { userId, locationIds, fcmToken, notificationEnabled } = req.body || {};
  if (!fcmToken || typeof fcmToken !== 'string' || !Array.isArray(locationIds)) {
    return res.status(400).json({ error: 'fcmToken and locationIds are required.' });
  }
  const saved = registerDeviceToken({
    userId: String(userId || 'worker-browser'),
    locationIds,
    fcmToken,
    notificationEnabled: notificationEnabled !== false,
  });
  res.status(201).json(saved);
});

// Admin-only Escalation Settings
app.post('/api/escalation/settings', requireAdminAuth, (req: Request, res: Response) => {
  const caller = (req as any).firebaseUser as VerifiedFirebaseUser;
  const updated = updateNotificationSettings(req.body || {}, caller.email);
  res.json(updated);
});

// Admin-only Monitored Locations Management
app.post('/api/escalation/locations', requireAdminAuth, (req: Request, res: Response) => {
  const { locationId, name, name_ta, region, ward_no, lat, lng, enabled } = req.body || {};
  if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Location name, numeric lat, and numeric lng are required.' });
  }
  const saved = upsertMonitoredLocation({
    locationId: locationId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    name_ta,
    region,
    ward_no,
    lat,
    lng,
    enabled: enabled !== false,
  });
  res.status(201).json(saved);
});

app.delete('/api/escalation/locations/:id', requireAdminAuth, (req: Request, res: Response) => {
  const deleted = deleteMonitoredLocation(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Location not found.' });
  res.json({ deleted: true });
});

// Preview location-based recipient targeting without sending alerts
app.get('/api/escalation/targeting-preview', (req: Request, res: Response) => {
  const locationId = String(req.query.locationId || 't-nagar');
  const risk = (String(req.query.risk || 'extreme') as any) || 'extreme';
  const targeted = getTargetedRecipients(locationId, risk);
  res.json({
    locationId,
    risk,
    smsCount: targeted.smsRecipients.length,
    pushCount: targeted.pushRecipients.length,
    deviceTokenCount: targeted.deviceTokens.length,
    smsRecipients: targeted.smsRecipients.map((r) => ({
      id: r.id,
      name: r.name,
      locationIds: r.locationIds,
      minRiskLevel: r.minRiskLevel,
    })),
    pushRecipients: targeted.pushRecipients.map((r) => ({
      id: r.id,
      name: r.name,
      locationIds: r.locationIds,
      minRiskLevel: r.minRiskLevel,
    })),
  });
});

// Admin-only Manual Monitoring Sweep
app.post('/api/escalation/run-now', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const result = await runScheduledHeatMonitor('manual');
    res.json({
      ...result,
      stats: getEscalationDashboardStats(),
      history: getAlertHistory(true),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Monitoring sweep failed' });
  }
});

// Admin-only Simulation Evaluation (NEVER sends real SMS or live emergency alerts)
app.post('/api/escalation/simulate', requireAdminAuth, async (req: Request, res: Response) => {
  const {
    locationId,
    airTemp,
    humidity,
    forcePreviousRisk,
    simulateSmsFailure,
    simulatePushFailure,
    forceChannels,
  } = req.body || {};

  const locations = getMonitoredLocations();
  const location = locations.find((l) => l.locationId === locationId) || locations[0];
  if (!location) {
    return res.status(404).json({ error: 'No monitored location available.' });
  }

  const numericTemp = Number(airTemp ?? 35);
  const numericHum = Number(humidity ?? 65);
  const hi = calculateRothfusz(numericTemp, numericHum);

  try {
    const result = await evaluateLocationHeatTransition({
      location,
      airTemp: numericTemp,
      humidity: numericHum,
      heatIndex: hi,
      forecastPeakHeatIndex: Math.round((hi + 1.5) * 10) / 10,
      trend: forcePreviousRisk && forcePreviousRisk !== 'low' ? 'falling' : 'rising',
      simulationMode: true,
      forcePreviousRisk,
      simulateSmsFailure: Boolean(simulateSmsFailure),
      simulatePushFailure: Boolean(simulatePushFailure),
      forceChannels,
      useAiAdvisor: false,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Simulation evaluation failed' });
  }
});

// Admin-only Retry Failed Deliveries
app.post('/api/escalation/retry-failed', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const outcome = await retryFailedSmsDeliveries();
    res.json({
      ...outcome,
      stats: getEscalationDashboardStats(),
      smsDeliveries: getSmsDeliveries(),
      history: getAlertHistory(true),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Retry failed' });
  }
});

// Admin-only Live Phone SMS Demo (dispatches 1 real SMS via SMS_API_URL / SMS_API_KEY)
let lastDemoSmsAt = 0;
app.post('/api/escalation/send-demo-sms', requireAdminAuth, async (req: Request, res: Response) => {
  const { phone, locationId, riskLevel, consentConfirmed } = req.body || {};

  if (!consentConfirmed) {
    return res.status(400).json({
      error: 'Please confirm recipient opt-in consent before sending a live demo alert.',
    });
  }
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: 'Phone number is required (e.g. +916374799286).' });
  }

  const now = Date.now();
  if (now - lastDemoSmsAt < 15_000) {
    const waitSec = Math.ceil((15_000 - (now - lastDemoSmsAt)) / 1000);
    return res.status(429).json({
      error: `Please wait ${waitSec}s before sending another live demo alert.`,
    });
  }

  try {
    lastDemoSmsAt = now;
    const outcome = await sendLiveDemoSms({
      phone: phone.trim(),
      locationId: typeof locationId === 'string' ? locationId : undefined,
      riskLevel: riskLevel === 'high' ? 'high' : 'extreme',
    });
    res.json(outcome);
  } catch (err: any) {
    lastDemoSmsAt = 0;
    res.status(400).json({ error: err?.message || 'Live demo alert dispatch failed' });
  }
});

// Admin-only Live Gemini AI Escalation Briefing
app.post('/api/escalation/ai-brief', requireAdminAuth, async (req: Request, res: Response) => {
  const { locationId } = req.body || {};
  const states = getAlertStates();
  const state = states.find((s) => s.locationId === locationId) || states[0];
  if (!state) {
    return res.status(404).json({ error: 'No live monitoring state available yet. Run a monitoring sweep first.' });
  }
  const analysis = await generateAiEscalationAnalysis({
    locationName: state.locationName,
    previousRisk: state.previousRisk,
    currentRisk: state.currentRisk,
    direction: state.currentRisk === 'low' ? 'recovery' : 'escalation',
    airTemp: state.currentTemp,
    humidity: state.currentHumidity,
    heatIndex: state.currentHeatIndex,
    forecastPeakHeatIndex: state.forecastPeakHeatIndex || state.currentHeatIndex,
    trend: state.trend,
  });
  res.json(analysis);
});

// ==========================================
// ADVANCED HEAT-SAFETY INTELLIGENCE ROUTES
// ==========================================

app.get('/api/shade-estimate', async (req: Request, res: Response) => {
  const lat = Number(req.query.lat ?? 13.06);
  const lng = Number(req.query.lng ?? 80.22);
  const radius = Number(req.query.radius ?? 450);
  const departureTimeIso =
    typeof req.query.departure === 'string' && req.query.departure.trim()
      ? req.query.departure.trim()
      : new Date().toISOString();
  const cloudCoverRaw = req.query.cloudCover !== undefined ? Number(req.query.cloudCover) : null;
  const cloudCoverPct =
    cloudCoverRaw !== null && Number.isFinite(cloudCoverRaw) ? cloudCoverRaw : null;

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Valid numeric lat and lng query parameters are required.' });
  }

  try {
    const result = await estimateAreaShade({
      lat,
      lng,
      radiusMeters: Number.isFinite(radius) ? radius : 450,
      departureTimeIso,
      cloudCoverPct,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Shade prediction failed' });
  }
});

app.post('/api/cool-route', async (req: Request, res: Response) => {
  const { origin, destination, departureTimeIso } = req.body || {};
  const oLat = Number(origin?.lat);
  const oLng = Number(origin?.lng);
  const dLat = Number(destination?.lat);
  const dLng = Number(destination?.lng);

  if (
    !Number.isFinite(oLat) ||
    !Number.isFinite(oLng) ||
    !Number.isFinite(dLat) ||
    !Number.isFinite(dLng)
  ) {
    return res.status(400).json({
      error: 'Valid origin { lat, lng } and destination { lat, lng } coordinates are required.',
    });
  }

  try {
    const result = await computeCoolRoutes({
      origin: {
        lat: oLat,
        lng: oLng,
        label: typeof origin?.label === 'string' ? origin.label.slice(0, 100) : 'Start Point',
      },
      destination: {
        lat: dLat,
        lng: dLng,
        label:
          typeof destination?.label === 'string' ? destination.label.slice(0, 100) : 'Destination',
      },
      departureTimeIso:
        typeof departureTimeIso === 'string' && departureTimeIso.trim()
          ? departureTimeIso.trim()
          : new Date().toISOString(),
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'CoolRoute calculation failed' });
  }
});

app.get('/api/forecast-extended', async (req: Request, res: Response) => {
  const lat = Number(req.query.lat ?? 13.06);
  const lng = Number(req.query.lng ?? 80.22);
  const label =
    typeof req.query.label === 'string' && req.query.label.trim()
      ? req.query.label.trim().slice(0, 100)
      : 'Chennai Region';
  const rawHorizon = Number(req.query.horizon ?? 72);
  const horizonHours = rawHorizon === 24 ? 24 : rawHorizon === 48 ? 48 : 72;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Valid numeric lat and lng coordinates are required.' });
  }

  try {
    const result = await getExtendedForecastWithUncertainty({
      lat,
      lng,
      label,
      horizonHours,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Extended forecast lookup failed' });
  }
});

// ==========================================
// SATELLITE TILE PROXY & PLACE GEOCODING
// ==========================================

const TRANSPARENT_PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

interface CachedTile {
  buffer: Buffer;
  contentType: string;
  cachedAt: number;
}

const TILE_CACHE_MAX_ITEMS = 350;
const TILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour server-side tile cache
const tileMemoryCache = new Map<string, CachedTile>();

function setTileCache(key: string, value: CachedTile) {
  if (tileMemoryCache.size >= TILE_CACHE_MAX_ITEMS) {
    const oldestKey = tileMemoryCache.keys().next().value;
    if (oldestKey) tileMemoryCache.delete(oldestKey);
  }
  tileMemoryCache.set(key, value);
}

function parseTileCoords(req: Request): { z: number; y: number; x: number } | null {
  const z = Number(req.params.z);
  const y = Number(req.params.y);
  const x = Number(req.params.x);
  if (
    !Number.isInteger(z) ||
    !Number.isInteger(y) ||
    !Number.isInteger(x) ||
    z < 0 ||
    z > 19
  ) {
    return null;
  }
  const maxIndex = Math.pow(2, z);
  if (x < 0 || y < 0 || x >= maxIndex || y >= maxIndex) {
    return null;
  }
  return { z, y, x };
}

async function fetchUpstreamImage(url: string, timeoutMs = 6500): Promise<{ buffer: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ChennaiHeatGuard/1.2 (+https://chennai-heat-guard.local)',
        Accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8',
      },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return null;
    const arrayBuf = await resp.arrayBuffer();
    if (arrayBuf.byteLength < 100) return null;
    return { buffer: Buffer.from(arrayBuf), contentType };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

app.get('/api/tiles/satellite/:z/:y/:x', async (req: Request, res: Response) => {
  const coords = parseTileCoords(req);
  if (!coords) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }

  const { z, y, x } = coords;
  const cacheKey = `sat:${z}/${y}/${x}`;
  const cached = tileMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < TILE_CACHE_TTL_MS) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buffer);
  }

  // Failover chain: Esri World Imagery primary -> Esri Services mirror -> EOX Sentinel-2 Cloudless (z<=15)
  const candidates = [
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  ];
  if (z <= 15) {
    candidates.push(
      `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`
    );
  }

  for (const upstreamUrl of candidates) {
    const img = await fetchUpstreamImage(upstreamUrl, 6000);
    if (img) {
      setTileCache(cacheKey, { ...img, cachedAt: Date.now() });
      res.setHeader('Content-Type', img.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(img.buffer);
    }
  }

  res.status(502).setHeader('Content-Type', 'image/png').send(TRANSPARENT_PNG_1X1);
});

app.get('/api/tiles/labels/:z/:y/:x', async (req: Request, res: Response) => {
  const coords = parseTileCoords(req);
  if (!coords) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }

  const { z, y, x } = coords;
  const cacheKey = `lbl:${z}/${y}/${x}`;
  const cached = tileMemoryCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < TILE_CACHE_TTL_MS) {
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buffer);
  }

  const upstreamUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
  const img = await fetchUpstreamImage(upstreamUrl, 5000);
  if (img) {
    setTileCache(cacheKey, { ...img, cachedAt: Date.now() });
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(img.buffer);
  }

  // Always return a valid transparent PNG if reference labels fail so imagery remains unobstructed
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(TRANSPARENT_PNG_1X1);
});

interface GeocodeCacheEntry {
  cachedAt: number;
  results: Array<{
    id: string;
    label: string;
    sublabel: string;
    lat: number;
    lng: number;
    source: 'osm-nominatim';
  }>;
}

const GEOCODE_CACHE_TTL_MS = 30 * 60 * 1000;
const geocodeCache = new Map<string, GeocodeCacheEntry>();
let lastNominatimCallAt = 0;

app.get('/api/geocode', async (req: Request, res: Response) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (rawQuery.length < 2) {
    return res.json({ results: [] });
  }
  const normalizedQuery = rawQuery.slice(0, 120).toLowerCase();

  const cached = geocodeCache.get(normalizedQuery);
  if (cached && Date.now() - cached.cachedAt < GEOCODE_CACHE_TTL_MS) {
    return res.json({ results: cached.results, cached: true });
  }

  // Gentle Nominatim usage policy guard (~1 req/sec)
  const elapsed = Date.now() - lastNominatimCallAt;
  if (elapsed < 900) {
    await new Promise((r) => setTimeout(r, 900 - elapsed));
  }
  lastNominatimCallAt = Date.now();

  const queryNominatim = async (bounded: boolean) => {
    const params = new URLSearchParams({
      format: 'jsonv2',
      addressdetails: '1',
      limit: '6',
      countrycodes: 'in',
      q: bounded ? rawQuery : `${rawQuery}, Chennai, Tamil Nadu`,
    });
    if (bounded) {
      // Greater Chennai bounding box: left,top,right,bottom
      params.set('viewbox', '79.92,13.36,80.42,12.74');
      params.set('bounded', '1');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    try {
      const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ChennaiHeatGuard/1.2 (public-heat-safety-app)',
          Accept: 'application/json',
          'Accept-Language': 'en',
        },
      });
      clearTimeout(timer);
      if (!resp.ok) return [];
      const raw = (await resp.json()) as any[];
      return Array.isArray(raw) ? raw : [];
    } catch {
      clearTimeout(timer);
      return [];
    }
  };

  try {
    let rawMatches = await queryNominatim(true);
    if (rawMatches.length === 0) {
      rawMatches = await queryNominatim(false);
    }

    const results = rawMatches
      .map((item) => {
        const lat = Number(item.lat);
        const lng = Number(item.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const displayName = String(item.display_name || rawQuery);
        const parts = displayName.split(',').map((s) => s.trim()).filter(Boolean);
        const primary = String(item.name || parts[0] || rawQuery);
        const sublabel = parts.slice(1, 4).join(', ') || 'Chennai, Tamil Nadu';
        return {
          id: `osm:${item.place_id || `${lat.toFixed(5)},${lng.toFixed(5)}`}`,
          label: primary,
          sublabel,
          lat: Number(lat.toFixed(5)),
          lng: Number(lng.toFixed(5)),
          source: 'osm-nominatim' as const,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    if (geocodeCache.size > 200) {
      const firstKey = geocodeCache.keys().next().value;
      if (firstKey) geocodeCache.delete(firstKey);
    }
    geocodeCache.set(normalizedQuery, { cachedAt: Date.now(), results });

    return res.json({ results });
  } catch (err: any) {
    return res.status(502).json({
      results: [],
      error: err?.message || 'Place search temporarily unavailable',
    });
  }
});

// Ensure unknown /api/* routes always return JSON instead of SPA HTML
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API route not found' });
});

// ==========================================
// VITE DEV SERVER / STATIC SERVING
// ==========================================
async function startServer() {
  const httpServer = http.createServer(app);
  const disableHmr = process.env.DISABLE_HMR === 'true' || Boolean(process.env.K_SERVICE);

  if (!isProd) {
    if (disableHmr) {
      app.get('/@vite/client', (_req: Request, res: Response) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(`
const sheetsMap = new Map();

export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}

export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}

export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}

export function injectQuery(url) {
  return url;
}

export class ErrorOverlay {}
`);
      });
    }

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: disableHmr ? false : undefined,
        hmr: disableHmr ? false : { server: httpServer },
        watch: disableHmr ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, () => {
    startBackgroundScheduler();
    console.log(`Chennai Heat Guard running locally:`);
    console.log(`  Worker App:       http://localhost:${PORT}`);
    console.log(`  Authority Portal: http://localhost:${PORT}/authority`);
  });
}

startServer();
