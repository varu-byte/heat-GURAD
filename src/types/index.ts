export type RiskLevel = 'low' | 'moderate' | 'high' | 'extreme';

export interface RiskThresholds {
  moderate: number; // default 32°C
  high: number; // default 36°C
  extreme: number; // default 41°C
}

export interface ChennaiZone {
  id: string;
  name: string;
  name_ta: string;
  ward_no: number;
  lat: number;
  lng: number;
  tree_cover_pct: number;
  built_up_pct: number;
  worker_density: number; // 0-100 scale index
  description: string;
  description_ta: string;
}

export interface ZoneReading {
  id: string;
  zone_id: string;
  time: string; // ISO string
  temp: number; // in °C
  humidity: number; // in %
  heat_index: number; // in °C (Rothfusz)
  predicted_heat_index?: number; // microclimate estimate
  risk: RiskLevel;
  source: 'api' | 'sensor';
  sensor_id?: string;
  is_live?: boolean;
  connection_status?: 'live' | 'offline';
  badge?: 'Live' | 'Offline';
  cache_age_seconds?: number;
  advice: string;
  advice_ta: string;
}

export interface HourlyForecast {
  hour: string; // '06:00', '07:00', etc.
  hour_num: number; // 6 to 22
  temp: number;
  humidity: number;
  heat_index: number;
  predicted_heat_index: number;
  risk: RiskLevel;
  is_safer: boolean;
  is_avoid: boolean;
}

export interface ZoneDetail extends ChennaiZone {
  current_reading: ZoneReading;
  hourly_readings: HourlyForecast[];
  safer_hours: string[];
  avoid_hours: string[];
  relief_points_count: number;
  active_sensor?: SensorDevice;
}

export type ReliefType = 'shade' | 'water' | 'cooling';

export interface ReliefPoint {
  id: string;
  zone_id: string;
  name: string;
  name_ta: string;
  type: ReliefType;
  lat: number;
  lng: number;
  address: string;
  address_ta: string;
  capacity: number; // people capacity
  verified: boolean;
  facilities: string[];
  facilities_ta?: string[];
  distance_km?: number;
}

export interface HeatAlert {
  id: string;
  timestamp: string;
  zone_id: string;
  zone_name: string;
  level: RiskLevel;
  heat_index: number;
  message: string;
  message_ta: string;
  sent_by: string;
}

export interface BreakLog {
  id: string;
  timestamp: string;
  worker_id: string;
  zone_id: string;
  zone_name: string;
  duration_mins: number;
  note?: string;
}

export interface SensorDevice {
  id: string;
  zone_id: string;
  zone_name: string;
  name: string;
  location_desc: string;
  location_desc_ta: string;
  last_reading_time: string;
  last_temp: number;
  last_humidity: number;
  last_heat_index: number;
  status: 'online' | 'offline';
  battery_pct: number;
  firmware_version: string;
}

export interface MiddayRestRule {
  enabled: boolean;
  start_hour: string; // e.g. "12:00"
  end_hour: string; // e.g. "16:00"
  threshold_heat_index: number; // e.g. 41°C
  mandatory_rest_mins_per_hour: number; // e.g. 15
  prohibited_activities: string[];
  prohibited_activities_ta: string[];
  last_updated: string;
  updated_by: string;
}

export type Language = 'en' | 'ta';

// ==========================================
// AUTOMATIC ALERT ESCALATION SYSTEM TYPES
// ==========================================

export type DeliveryStatus = 'sent' | 'partial' | 'failed' | 'simulated' | 'skipped';
export type NotificationChannel = 'push' | 'sms' | 'admin' | 'dashboard';
export type HeatTrend = 'rising' | 'falling' | 'stable';
export type AlertDirection = 'escalation' | 'de-escalation' | 'reminder' | 'recovery';

export interface MonitoredLocation {
  locationId: string;
  name: string;
  name_ta?: string;
  region?: string;
  ward_no?: number;
  lat: number;
  lng: number;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AlertStateRecord {
  locationId: string;
  locationName: string;
  currentRisk: RiskLevel;
  previousRisk: RiskLevel;
  currentHeatIndex: number;
  forecastPeakHeatIndex?: number;
  currentTemp: number;
  currentHumidity: number;
  trend: HeatTrend;
  lastEscalationTime: string | null;
  lastNotificationTime: string | null;
  lastEvaluatedAt: string;
  activeAlert: boolean;
  aiSummary?: string;
  updatedAt?: string;
}

export interface SmsDeliveryAttempt {
  attempt: number;
  timestamp: string;
  status: 'sent' | 'failed';
  providerResponse: string;
}

export interface SmsDeliveryRecord {
  id: string;
  eventId: string;
  recipientId: string;
  recipientName: string;
  phoneMasked: string;
  locationId: string;
  status: 'sent' | 'retrying' | 'failed' | 'simulated';
  attempts: SmsDeliveryAttempt[];
  lastError?: string;
  messagePreview: string;
  createdAt: string;
}

export interface AlertHistoryEvent {
  id: string;
  locationId: string;
  locationName: string;
  previousRisk: RiskLevel;
  currentRisk: RiskLevel;
  direction: AlertDirection;
  timestamp: string;
  notificationChannels: NotificationChannel[];
  recipientCount: number;
  pushCount?: number;
  smsCount?: number;
  failedCount?: number;
  deliveryStatus: DeliveryStatus;
  pushStatus: DeliveryStatus;
  smsStatus: DeliveryStatus;
  simulationMode: boolean;
  heatIndex: number;
  airTemp?: number;
  humidity?: number;
  safetyInstructions?: string;
  aiSummary?: string;
  reason?: string;
  pushPreview?: {
    title: string;
    body: string;
    locationName: string;
    riskLevel: RiskLevel;
    precautions: string[];
  };
  smsPreview?: {
    recipientPhonesMasked: string[];
    message: string;
  };
}

export interface NotificationSettings {
  monitoringInterval: number; // minutes (default 15)
  cooldownMinutes: number; // default 30
  reminderIntervalMinutes: number; // default 60
  smsEnabled: boolean;
  pushEnabled: boolean;
  escalationEnabled: boolean;
  notifyOnModerate: boolean;
  notifyOnDeescalation: boolean;
  moderateThreshold: number; // default 32
  highThreshold: number; // default 36
  extremeThreshold: number; // default 41
  maxRetries: number; // default 3
  updatedBy?: string;
  updatedAt?: string;
}

export interface RecipientSubscription {
  id: string;
  ownerUid: string;
  name: string;
  phone: string;
  locationIds: string[];
  pushEnabled: boolean;
  smsEnabled: boolean;
  consentGranted: boolean;
  consentTimestamp?: string;
  active: boolean;
  minRiskLevel: 'moderate' | 'high' | 'extreme';
  createdAt?: string;
  updatedAt?: string;
}

export interface DeviceTokenRecord {
  id: string;
  userId: string;
  locationIds: string[];
  fcmToken: string;
  notificationEnabled: boolean;
  updatedAt?: string;
}

export interface EscalationDashboardStats {
  totalActiveAlerts: number;
  riskCounts: Record<RiskLevel, number>;
  smsStats: {
    sent: number;
    failed: number;
    retrying: number;
    simulated: number;
  };
  pushStats: {
    sent: number;
    failed: number;
    simulated: number;
    registeredTokens: number;
  };
  failedNotificationsCount: number;
  schedulerStatus: {
    running: boolean;
    intervalMinutes: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
    runsCompleted: number;
  };
}

// ==========================================
// ADVANCED HEAT-SAFETY INTELLIGENCE TYPES
// ==========================================

export type MapBaseStyle = 'street' | 'satellite';

export type ShadeReliabilityLevel = 'high' | 'moderate' | 'low';

export interface SunPositionInfo {
  timestampIso: string;
  altitudeDeg: number;
  azimuthCompassDeg: number; // 0 = North, 90 = East, 180 = South, 270 = West
  isDaylight: boolean;
  sunriseIso: string;
  sunsetIso: string;
  solarLabel: string;
}

export interface EstimatedShadowPolygon {
  id: string;
  coordinates: [number, number][]; // [lat, lng] polygon ring
  source: 'measured-height' | 'levels-estimated' | 'footprint-inferred' | 'tree-canopy';
  heightMeters: number;
  isEstimated: true;
}

export interface ShadedRoadSegment {
  id: string;
  coordinates: [number, number][];
  shadeScore: number; // 0 (full sun) to 1 (shaded)
  classification: 'shaded' | 'partial' | 'sunny';
  basis: string;
}

export interface TreeCanopyNode {
  id: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  source: 'osm-tree' | 'osm-park' | 'osm-forest' | 'osm-meadow' | 'relief-shade';
}

export interface ShadeReliabilitySummary {
  level: ShadeReliabilityLevel;
  dataSource: 'osm-overpass' | 'partial-osm' | 'unavailable';
  estimationMode: 'measured-osm' | 'inferred-footprint-and-canopy' | 'solar-and-relief-fallback';
  buildingsTotal: number;
  buildingsWithMeasuredHeight: number;
  buildingsWithLevels: number;
  buildingsInferredHeight: number;
  buildingsMissingHeight: number;
  treesFound: number;
  parksFound: number;
  greenZonesFound: number;
  nearbyReliefPointsUsed: number;
  cloudCoverPct: number | null;
  reason: string;
}

export interface ShadePredictionResponse {
  center: { lat: number; lng: number };
  departureTimeIso: string;
  sunPosition: SunPositionInfo;
  buildingShadows: EstimatedShadowPolygon[];
  roadSegments: ShadedRoadSegment[];
  treeCanopies: TreeCanopyNode[];
  reliability: ShadeReliabilitySummary;
  disclaimer: string;
}

export type CoolRouteProfileId = 'fastest' | 'most-shaded' | 'balanced';

export interface RoutePointRef {
  id: string;
  name: string;
  name_ta?: string;
  type: ReliefType;
  lat: number;
  lng: number;
  distanceFromRouteMeters: number;
  verified: boolean;
}

export interface CoolRouteOption {
  profile: CoolRouteProfileId;
  title: string;
  titleTa: string;
  subtitle: string;
  coordinates: [number, number][]; // [lat, lng] polyline
  distanceMeters: number;
  walkingMinutes: number;
  estimatedShadePct: number; // Explicitly presented as an estimate, not a guarantee
  shadedSegmentSharePct: number;
  nearbyWaterCount: number;
  nearbyShadeCount: number;
  nearbyReliefPoints: RoutePointRef[];
  exposureHeatIndex: number;
  exposureRisk: RiskLevel;
  reliability: ShadeReliabilityLevel;
  estimationMode: ShadeReliabilitySummary['estimationMode'];
  shadeBasisNote: string;
  routingSource: 'osrm-foot' | 'corridor-fallback';
  isDistinctPath: boolean;
}

export interface CoolRouteResponse {
  origin: { lat: number; lng: number; label: string };
  destination: { lat: number; lng: number; label: string };
  departureTimeIso: string;
  sunPosition: SunPositionInfo;
  reliability: ShadeReliabilitySummary;
  weatherSummary: {
    temp: number;
    humidity: number;
    heatIndex: number;
    cloudCoverPct: number | null;
    risk: RiskLevel;
    isLive: boolean;
  };
  routes: CoolRouteOption[];
  shadeDisclaimer: string;
  reliabilityWarning: string | null;
}

export type ForecastHorizon = 24 | 48 | 72;

export interface ExtendedForecastHour {
  timeIso: string;
  hourLabel: string;
  dayIndex: number; // 0, 1, 2
  dayLabel: string;
  temp: number;
  tempMin: number | null;
  tempMax: number | null;
  humidity: number;
  heatIndex: number;
  heatIndexMin: number | null;
  heatIndexMax: number | null;
  cloudCoverPct: number | null;
  risk: RiskLevel;
}

export interface ForecastDaySummary {
  dayIndex: number;
  dateLabel: string;
  peakTemp: number;
  minTemp: number;
  peakHeatIndex: number;
  peakHeatIndexMin: number | null;
  peakHeatIndexMax: number | null;
  avgHumidity: number;
  peakRisk: RiskLevel;
  extremeHoursCount: number;
  saferWindow: string;
  riskyWindow: string;
}

export interface ForecastCalibrationSummary {
  calibrated: boolean;
  pairedSamplesCount: number;
  maeTempC: number | null;
  maeHeatIndexC: number | null;
  note: string;
}

export interface ExtendedForecastResponse {
  location: { lat: number; lng: number; label: string };
  horizonHours: ForecastHorizon;
  generatedAtIso: string;
  isLive: boolean;
  uncertaintySource: 'open-meteo-ensemble' | 'empirical-calibration' | 'uncalibrated';
  uncertaintyMethodNote: string;
  calibration: ForecastCalibrationSummary;
  hours: ExtendedForecastHour[];
  dailySummaries: ForecastDaySummary[];
}

