import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GeocodePlaceResult, searchChennaiPlaces } from '../../services/intelligenceApi';
import { Loader2, MapPin, Search, X } from 'lucide-react';

export interface PlaceOption {
  id: string;
  label: string;
  group: string;
  lat: number;
  lng: number;
}

interface Props {
  id: string;
  label: string;
  placeholder: string;
  value: { id: string; lat: number; lng: number; label: string };
  localOptions: PlaceOption[];
  onSelect: (choice: { id: string; lat: number; lng: number; label: string }) => void;
  isPickingOnMap: boolean;
  onTogglePickOnMap: () => void;
}

export const PlaceSearchInput: React.FC<Props> = ({
  id,
  label,
  placeholder,
  value,
  localOptions,
  onSelect,
  isPickingOnMap,
  onTogglePickOnMap,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(value.label);
  const [isOpen, setIsOpen] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [remoteResults, setRemoteResults] = useState<GeocodePlaceResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Sync displayed text whenever parent updates selection (GPS, swap, map tap)
  useEffect(() => {
    setQuery(value.label);
    setIsDirty(false);
  }, [value.id, value.label, value.lat, value.lng]);

  // Dismiss dropdown on outside click
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setQuery(value.label);
        setIsDirty(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [value.label]);

  // Instant local filtering of GPS, Chennai zones, monitored locations & verified relief spots
  const filteredLocal = useMemo(() => {
    const q = isDirty ? query.trim().toLowerCase() : '';
    if (!q) return localOptions.slice(0, 10);
    return localOptions
      .filter(
        (opt) =>
          opt.label.toLowerCase().includes(q) || opt.group.toLowerCase().includes(q)
      )
      .slice(0, 6);
  }, [localOptions, query, isDirty]);

  // Debounced street/landmark search via /api/geocode (Nominatim Chennai proxy)
  useEffect(() => {
    if (!isOpen || !isDirty) {
      setRemoteResults([]);
      setSearching(false);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setRemoteResults([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      searchChennaiPlaces(trimmed, controller.signal)
        .then((res) => {
          setRemoteResults(res);
        })
        .catch(() => {
          setRemoteResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isOpen, isDirty]);

  const handleChoose = (choice: { id: string; lat: number; lng: number; label: string }) => {
    onSelect(choice);
    setQuery(choice.label);
    setIsDirty(false);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="space-y-1 relative">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-[11px] font-bold uppercase text-stone-500 dark:text-stone-400">
          {label}
        </label>
        <button
          type="button"
          onClick={onTogglePickOnMap}
          className={`text-[11px] font-bold cursor-pointer whitespace-nowrap shrink-0 ${
            isPickingOnMap ? 'text-orange-600 underline' : 'text-blue-600 dark:text-blue-400'
          }`}
        >
          {isPickingOnMap ? 'Tap map to set...' : 'Pick on map'}
        </button>
      </div>

      <div className="relative">
        <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          value={query}
          placeholder={placeholder}
          onFocus={() => {
            setIsOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsDirty(true);
            setIsOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setIsOpen(false);
              setQuery(value.label);
              setIsDirty(false);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (remoteResults[0]) {
                handleChoose({
                  id: remoteResults[0].id,
                  lat: remoteResults[0].lat,
                  lng: remoteResults[0].lng,
                  label: remoteResults[0].label,
                });
              } else if (filteredLocal[0]) {
                handleChoose(filteredLocal[0]);
              }
            }
          }}
          className="w-full min-h-[42px] rounded-xl border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 pl-8 pr-8 py-2 text-xs font-bold text-stone-900 dark:text-stone-100 placeholder:font-normal placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500"
        />

        {searching ? (
          <Loader2 className="w-3.5 h-3.5 text-orange-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        ) : (
          query.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setIsDirty(true);
                setIsOpen(true);
              }}
              aria-label={`Clear ${label}`}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )
        )}
      </div>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-64 overflow-y-auto rounded-xl bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 shadow-xl divide-y divide-stone-100 dark:divide-stone-800">
          {/* Remote OpenStreetMap street & landmark search hits */}
          {remoteResults.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] font-bold text-stone-400 dark:text-stone-500 bg-stone-50/80 dark:bg-stone-950/60">
                Streets &amp; Landmarks (Chennai)
              </div>
              {remoteResults.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() =>
                    handleChoose({
                      id: item.id,
                      lat: item.lat,
                      lng: item.lng,
                      label: item.label,
                    })
                  }
                  className="w-full min-h-[44px] px-3 py-2 text-left hover:bg-orange-50 dark:hover:bg-stone-800 transition flex items-start gap-2 cursor-pointer"
                >
                  <MapPin className="w-3.5 h-3.5 text-orange-600 shrink-0 mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-bold text-stone-900 dark:text-stone-100 truncate">
                      {item.label}
                    </span>
                    <span className="block text-[11px] text-stone-500 dark:text-stone-400 truncate">
                      {item.sublabel}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Local instant matches: GPS, Zones, Verified Relief Spots */}
          {filteredLocal.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] font-bold text-stone-400 dark:text-stone-500 bg-stone-50/80 dark:bg-stone-950/60">
                {isDirty && query.trim() ? 'Matching Zones & Verified Relief Spots' : 'Quick Picks — Zones & Relief Spots'}
              </div>
              {filteredLocal.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleChoose(opt)}
                  className="w-full min-h-[44px] px-3 py-2 text-left hover:bg-stone-50 dark:hover:bg-stone-800 transition flex items-center justify-between gap-2 cursor-pointer"
                >
                  <span className="text-xs font-semibold text-stone-800 dark:text-stone-100 truncate">
                    {opt.label}
                  </span>
                  <span className="text-[10px] text-stone-400 dark:text-stone-500 whitespace-nowrap shrink-0">
                    {opt.group}
                  </span>
                </button>
              ))}
            </div>
          )}

          {!searching && filteredLocal.length === 0 && remoteResults.length === 0 && (
            <div className="px-3 py-3 text-xs text-stone-500 dark:text-stone-400">
              No places found for &ldquo;{query}&rdquo;. Try a Chennai road, area, or landmark name, or tap &ldquo;Pick on map&rdquo;.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
