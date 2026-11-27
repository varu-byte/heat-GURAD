# Chennai Heat Guard (சென்னை வெப்பக் காப்பகம்)

> **Extreme Heat Exposure Protection & Thermal Safety Platform for Outdoor Workers in Chennai**  
> Developed for Greater Chennai Corporation (GCC) & Public Health Action.

Chennai Heat Guard is a production-grade full-stack Progressive Web App (React 19 + Express.js backend) designed specifically to shield Chennai's outdoor labor force—including construction laborers, street vendors, delivery partners, sanitation crews, traffic police, and autowalas—from life-threatening heat stress and heat stroke.

---

## 🌟 Core Architecture & Data Engine

### 1. Dual-Source Meteorological Adapter (`getReadings`)
The backend provides a single unified adapter `getReadings(zoneId)` with two data streams:
1. **Open-Meteo API**: Fetches real-time hourly `temperature_2m` and `relative_humidity_2m` for Chennai coordinates without requiring any API key.
2. **ESP32 Ground Sensors**: Ground-deployed IoT sensors running DHT22 units. **When sensor telemetry exists in the database for that zone, it overrides the satellite/model API**, ensuring street-level hyper-local accuracy.

### 2. The 10 Chennai Zones & Coordinates
| Zone ID | Zone Name | Tamil Name | Ward | Lat | Lng | Built-up % | Tree Cover % | Worker Density |
|---------|-----------|------------|------|-----|-----|------------|--------------|----------------|
| `koyambedu` | Koyambedu | கோயம்பேடு | 127 | 13.0694 | 80.1948 | 92% | 8% | 98/100 |
| `t-nagar` | T. Nagar | தி. நகர் | 141 | 13.0418 | 80.2341 | 88% | 12% | 95/100 |
| `guindy` | Guindy | கிண்டி | 168 | 13.0067 | 80.2025 | 82% | 18% | 85/100 |
| `marina` | Marina Beach | மெரினா கடற்கரை | 111 | 13.0500 | 80.2824 | 75% | 6% | 88/100 |
| `ennore` | Ennore | எண்ணூர் | 1 | 13.2030 | 80.3230 | 95% | 5% | 89/100 |
| `velachery` | Velachery | வேளச்சேரி | 178 | 12.9815 | 80.2180 | 85% | 15% | 78/100 |
| `tambaram` | Tambaram | தாம்பரம் | 200 | 12.9249 | 80.1000 | 78% | 22% | 82/100 |
| `anna-nagar` | Anna Nagar | அண்ணா நகர் | 100 | 13.0850 | 80.2101 | 74% | 26% | 72/100 |
| `adyar` | Adyar | அடையாறு | 173 | 13.0012 | 80.2565 | 72% | 28% | 65/100 |
| `perambur` | Perambur | பெரம்பூர் | 70 | 13.1075 | 80.2334 | 86% | 14% | 84/100 |

### 3. Rothfusz Heat Index (°C) & Risk Categorization
Calculates felt temperature using the full NOAA Rothfusz regression equation:
- **Low Risk (< 33°C)**: Green — Normal outdoor shifts permitted with regular hydration.
- **High Risk (33°C – 41°C)**: Amber/Yellow — Caution, mandatory 15-minute shaded rest per hour, electrolyte fluids.
- **Extreme Risk (> 41°C)**: Red — Dangerous heat stroke threshold. Midday rest rule active (cease heavy outdoor labor 12:00–16:00).

### 4. Urban Microclimate Prediction Model
Street-level heat index estimation:
$$\text{Thermal Delta} = (\text{Built-up \%} \times 0.038) - (\text{Tree Cover \%} \times 0.032) \times \text{Solar Radiation Factor}$$
Displays a **"Predicted vs Measured"** comparison once live sensor data is received.

---

## 📱 Worker App (Mobile-First, Bottom Tabs)

1. **Home (முகப்பு)**:
   - Area selector & 1-tap **GPS Location Auto-detect** (calculates nearest Chennai zone).
   - Massive Heat Index gauge in °C with real-time felt temperature.
   - Tailored worker safety guidance in English and தமிழ் (Tamil).
   - Workday thermal timeline bar from **06:00 to 22:00** colored by risk.
   - Safer hours and Avoid-work hour chips.
2. **Heat Map (வரைபடம்)**:
   - Leaflet + OpenStreetMap interactive canvas.
   - Coloured heat circles per zone showing real-time risk footprint.
   - Interactive popups with microclimate data and relief facility counts.
   - Layer toggles for relief points and user GPS location pin.
3. **Relief Spots (அருகில்)**:
   - Categorized directory of **Shade (☂️)**, **Water (💧)**, and **Cooling Centers (❄️)**.
   - Automatically sorted by distance from the worker's GPS/zone.
   - Facility amenities (Amma Kudineer, ORS sachets, misting fans, air coolers, seating).
   - **"Get Directions"** button opening turn-by-turn navigation.
4. **Alerts & Rest (எச்சரிக்கை)**:
   - Live emergency bulletins from Greater Chennai Corporation.
   - Interactive **"I took a break" (15m)** counter logging rest breaks directly to the database.
   - Browser push notification toggle alerting workers when zone heat index turns extreme (>41°C).
   - Heat exhaustion vs Heat stroke medical guide with 1-click **108 Emergency Dial**.

### Worker Accessibility
- **English / தமிழ் Bilingual**: Seamless toggle across every single label and advisory.
- **High Contrast Mode**: Inverted high-contrast styling optimized for direct Chennai sunlight.
- **Large Text Mode**: Enlarged typography and tactile buttons for readability while on shifts.
- **PWA Offline Support**: Fully functional offline using service worker asset caching and `localStorage` fallback.

---

## 🏢 Read-Only GCC Authority Portal (`/authority`)

Accessible at **`/authority`** or via the **"Authority Portal"** toggle in the header (no login required, zero database writes):

1. **HOTSPOTS**:
   - Interactive Leaflet + OpenStreetMap view with area circles colored by Rothfusz heat index (`< 33°C` green, `33–41°C` amber, `> 41°C` red) computed from `getReadings()` and `heatIndex()`.
   - Independent toggle layers for **Shade**, **Water**, and **Cooling** points loaded from the static `data/relief-points.json` file.
   - Right panel showing the **Top 5 Hottest Areas Now** (with heat index and extreme hours today) and a **Live / Offline** badge.
2. **PRIORITY TABLE**:
   - Ranks Chennai areas by `(extreme hours today × relief gap)` using Haversine distances within 500 m (`reliefGap = max(0, 3 − shade/water points within 500 m)`).
   - Displays all underlying numbers behind each rank and a suggested action per row (`Add shade`, `Add water point`, or both).
3. **SUMMARY**:
   - Fixed read-only guidance displaying the recommended midday-rest window (`12:00–16:00` when risk is extreme), labeled **Recommendation** and **Not Enforced**.

Developers manage the static relief inventory by editing **`data/relief-points.json`** directly.

---

## 🛠️ REST API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/zones` | `GET` | Returns all 10 zones with current weather, heat index, and risk |
| `/api/zones/:id` | `GET` | Detailed zone data with 06:00–22:00 hourly timeline |
| `/api/sensor` | `POST` | Ingests `{sensor_id, temp, humidity, timestamp}` from ESP32 |
| `/api/relief-points` | `GET` | Returns static relief points from `data/relief-points.json` (filterable by `?zone_id=` or `?type=`) |
| `/api/alerts` | `GET` | Lists thermal alerts |
| `/api/breaks` | `GET` / `POST` | Fetches break stats or logs worker's 15m rest break |

---

## 💻 Running Locally on Your Laptop (Windows / macOS / Linux)

### Prerequisites
- **Node.js 18+** (Node.js 20 LTS or 22 LTS recommended) and **npm**

### Quick Start
```bash
# 1. Extract the ZIP archive and enter the project folder
cd chennai-heat-guard

# 2. Install dependencies
npm install

# 3. (Optional) Copy .env.example to .env if you want to customize PORT
# Open-Meteo live weather works with NO API key required!

# 4. Start the full-stack app (Express backend + Vite React frontend)
npm run dev
```

Open your browser:
- **Worker PWA:** `http://localhost:3000`
- **Read-Only Authority Portal:** `http://localhost:3000/authority`

### Production Build (Optional)
```bash
npm run build
npm run start:prod
```
