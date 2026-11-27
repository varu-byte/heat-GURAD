import L from 'leaflet';
import { MapBaseStyle } from '../types';

export const STREET_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const STREET_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Same-origin proxied satellite imagery & hybrid reference labels (avoids iframe/adblocker blocking)
export const SATELLITE_TILE_URL = '/api/tiles/satellite/{z}/{y}/{x}';
export const SATELLITE_LABELS_URL = '/api/tiles/labels/{z}/{y}/{x}';
export const SATELLITE_ATTRIBUTION =
  'Imagery &copy; Esri, Maxar, Earthstar Geographics, EOX Sentinel-2 &amp; GIS User Community';

export function createBaseTileLayer(style: MapBaseStyle): L.Layer {
  if (style === 'satellite') {
    const imagery = L.tileLayer(SATELLITE_TILE_URL, {
      attribution: SATELLITE_ATTRIBUTION,
      maxNativeZoom: 18,
      maxZoom: 19,
      zIndex: 1,
      crossOrigin: false,
    });
    const labels = L.tileLayer(SATELLITE_LABELS_URL, {
      maxNativeZoom: 18,
      maxZoom: 19,
      zIndex: 2,
      opacity: 0.92,
      crossOrigin: false,
    });
    return L.layerGroup([imagery, labels]);
  }

  return L.tileLayer(STREET_TILE_URL, {
    attribution: STREET_ATTRIBUTION,
    maxNativeZoom: 19,
    maxZoom: 19,
    zIndex: 1,
  });
}

/**
 * Safely swaps the base map layer (Street <-> Hybrid Satellite + Labels) while
 * keeping all vector routes, estimated shade polygons, and relief pins on top.
 */
export function attachBaseLayer(
  map: L.Map,
  previousLayer: L.Layer | null,
  style: MapBaseStyle
): L.Layer {
  if (previousLayer && map.hasLayer(previousLayer)) {
    map.removeLayer(previousLayer);
  }

  const nextLayer = createBaseTileLayer(style).addTo(map);

  if (nextLayer instanceof L.TileLayer) {
    nextLayer.bringToBack();
  } else if (nextLayer instanceof L.LayerGroup) {
    const sublayers = nextLayer.getLayers();
    // Send labels back first, then imagery behind labels so imagery sits underneath labels
    for (let i = sublayers.length - 1; i >= 0; i--) {
      const sub = sublayers[i];
      if (sub instanceof L.TileLayer) {
        sub.bringToBack();
      }
    }
  }

  map.invalidateSize({ animate: false });
  return nextLayer;
}
