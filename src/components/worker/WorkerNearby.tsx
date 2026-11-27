import React, { useState, useMemo } from 'react';
import {
  Droplets,
  Umbrella,
  Snowflake,
  Navigation,
  CheckCircle2,
  Users,
  Search,
  Filter,
  MapPin,
} from 'lucide-react';
import { ReliefPoint, Language, ReliefType, ZoneDetail } from '../../types';
import { TRANSLATIONS } from '../../utils/translations';
import { calculateDistanceKmExact } from '../../services/location';

interface Props {
  reliefPoints: ReliefPoint[];
  zones: ZoneDetail[];
  selectedZoneId: string;
  userCoords: { lat: number; lng: number } | null;
  lang: Language;
}

export const WorkerNearby: React.FC<Props> = ({
  reliefPoints,
  zones,
  selectedZoneId,
  userCoords,
  lang,
}) => {
  const t = TRANSLATIONS[lang];
  const [filterType, setFilterType] = useState<'all' | ReliefType>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const currentZone = zones.find((z) => z.id === selectedZoneId) || zones[0];

  // Base coordinate for distance calculation: user's real GPS position if active, else selected area
  const baseLat = userCoords ? userCoords.lat : currentZone?.lat || 13.06;
  const baseLng = userCoords ? userCoords.lng : currentZone?.lng || 80.22;

  // Compute exact distance for accurate sorting, plus rounded display value
  const pointsWithDistance = useMemo(() => {
    return reliefPoints.map((rp) => {
      const exactDist = calculateDistanceKmExact(baseLat, baseLng, rp.lat, rp.lng);
      return {
        ...rp,
        exact_distance_km: exactDist,
        distance_km: Math.round(exactDist * 10) / 10,
      };
    });
  }, [reliefPoints, baseLat, baseLng]);

  // Filter & sort ascending by exact real distance
  const filteredPoints = useMemo(() => {
    let list = [...pointsWithDistance];

    if (filterType !== 'all') {
      list = list.filter((p) => p.type === filterType);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.name_ta.toLowerCase().includes(q) ||
          p.address.toLowerCase().includes(q) ||
          p.zone_id.toLowerCase().includes(q)
      );
    }

    list.sort((a, b) => a.exact_distance_km - b.exact_distance_km);
    return list;
  }, [pointsWithDistance, filterType, searchQuery]);

  return (
    <div className="max-w-3xl mx-auto px-3.5 sm:px-6 py-4 space-y-4 pb-24">
      {/* Title Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg sm:text-xl font-black text-stone-900 dark:text-stone-100 flex items-center gap-2">
            <MapPin className="w-5 h-5 text-orange-600" />
            {t.nearbyTitle}
          </h2>
          <p className="text-xs text-stone-500 mt-0.5">{t.nearbySubtitle}</p>
        </div>

        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[11px] font-bold border ${
            userCoords
              ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
              : 'bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border-stone-200 dark:border-stone-700'
          }`}
        >
          {userCoords
            ? lang === 'ta'
              ? 'தொலைவு: உங்கள் இருப்பிடத்திலிருந்து'
              : 'Sorted from: Your location'
            : lang === 'ta'
              ? `தொலைவு: ${currentZone?.name_ta || ''}`
              : `Sorted from: ${currentZone?.name || 'Chennai'}`}
        </span>
      </div>

      {/* Search & Category Filter Pills */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={lang === 'ta' ? 'இடம் அல்லது முகவரியைத் தேடு...' : 'Search facility name, street or landmark...'}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 text-xs sm:text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-hidden focus:ring-2 focus:ring-orange-500"
          />
        </div>

        {/* Category Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          <button
            onClick={() => setFilterType('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
              filterType === 'all'
                ? 'bg-stone-900 text-white dark:bg-orange-600'
                : 'bg-white dark:bg-stone-900 text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-800'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>{t.filterAll} ({reliefPoints.length})</span>
          </button>

          <button
            onClick={() => setFilterType('water')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
              filterType === 'water'
                ? 'bg-sky-600 text-white'
                : 'bg-white dark:bg-stone-900 text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-800'
            }`}
          >
            <Droplets className="w-3.5 h-3.5 text-sky-400" />
            <span>{t.filterWater}</span>
          </button>

          <button
            onClick={() => setFilterType('shade')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
              filterType === 'shade'
                ? 'bg-emerald-600 text-white'
                : 'bg-white dark:bg-stone-900 text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-800'
            }`}
          >
            <Umbrella className="w-3.5 h-3.5 text-emerald-400" />
            <span>{t.filterShade}</span>
          </button>

          <button
            onClick={() => setFilterType('cooling')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shrink-0 cursor-pointer ${
              filterType === 'cooling'
                ? 'bg-purple-600 text-white'
                : 'bg-white dark:bg-stone-900 text-stone-600 dark:text-stone-300 border border-stone-200 dark:border-stone-800'
            }`}
          >
            <Snowflake className="w-3.5 h-3.5 text-purple-300" />
            <span>{t.filterCooling}</span>
          </button>
        </div>
      </div>

      {/* Relief Points List */}
      <div className="space-y-3">
        {filteredPoints.length === 0 ? (
          <div className="bg-white dark:bg-stone-900 p-8 rounded-2xl text-center border border-stone-200 dark:border-stone-800">
            <p className="text-stone-500 text-sm">No relief facilities match your filter.</p>
          </div>
        ) : (
          filteredPoints.map((point) => {
            const isWater = point.type === 'water';
            const isShade = point.type === 'shade';
            const isCooling = point.type === 'cooling';

            const badgeBg = isWater
              ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/80 dark:text-sky-300 border-sky-300 dark:border-sky-800'
              : isShade
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                : 'bg-purple-100 text-purple-800 dark:bg-purple-950/80 dark:text-purple-300 border-purple-300 dark:border-purple-800';

            const typeIcon = isWater ? (
              <Droplets className="w-4 h-4 text-sky-500" />
            ) : isShade ? (
              <Umbrella className="w-4 h-4 text-emerald-500" />
            ) : (
              <Snowflake className="w-4 h-4 text-purple-400" />
            );

            // Google Maps Navigation Link
            const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`;

            return (
              <div
                key={point.id}
                className="bg-white dark:bg-stone-900 rounded-2xl p-4 sm:p-5 shadow-sm border border-stone-200 dark:border-stone-800 transition hover:border-orange-300 dark:hover:border-orange-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5"
              >
                <div className="flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold border uppercase tracking-wide ${badgeBg}`}
                    >
                      {typeIcon}
                      {point.type}
                    </span>

                    {point.verified && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {t.verifiedGCC}
                      </span>
                    )}

                    <span className="text-[11px] text-stone-500 font-mono">
                      Zone: {point.zone_id.toUpperCase()}
                    </span>
                  </div>

                  <h3 className="text-sm sm:text-base font-extrabold text-stone-900 dark:text-stone-100 leading-snug">
                    {lang === 'ta' ? point.name_ta : point.name}
                  </h3>

                  <p className="text-xs text-stone-600 dark:text-stone-400">
                    {lang === 'ta' ? point.address_ta : point.address}
                  </p>

                  {/* Amenities / Facilities tags */}
                  {point.facilities && point.facilities.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {point.facilities.map((fac, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 rounded-md bg-stone-100 dark:bg-stone-800 text-[11px] text-stone-700 dark:text-stone-300"
                        >
                          {fac}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-3 pt-1 text-[11px] text-stone-500">
                    <span className="flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" />
                      {t.capacity}: {point.capacity} {t.people}
                    </span>
                  </div>
                </div>

                {/* Distance & Action */}
                <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2 pt-2 sm:pt-0 border-t sm:border-t-0 border-stone-100 dark:border-stone-800">
                  <div className="text-left sm:text-right">
                    <span className="text-base sm:text-lg font-black text-orange-600 dark:text-orange-400">
                      {point.distance_km} km
                    </span>
                    <span className="text-[10px] text-stone-500 block">{t.distanceAway}</span>
                  </div>

                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-xs font-bold shadow-sm transition active:scale-95 cursor-pointer"
                  >
                    <Navigation className="w-3.5 h-3.5" />
                    <span>{t.directions}</span>
                  </a>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
