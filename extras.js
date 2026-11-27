// Ride time between two stations (for arrival times) and the day's weather.
//
// Both change slowly, so both are cached: the ride time in memory and in
// the TIMETABLE KV namespace for a week, the forecast in memory for 30
// minutes. A failure is never cached, so the next request simply tries again.

/* ------------------------- Ride time ------------------------- */

const RIDE_TTL_S = 7 * 24 * 3600;
const RIDE_MEM = new Map();

/**
 * WMATA's scheduled ride time in whole minutes between two stations,
 * from its station-to-station information (part of the Default Tier).
 * Response: { StationToStationInfos: [{ SourceStation, DestinationStation, RailTime, ... }] }
 */
export async function rideMinutes(env, from, to) {
  const id = from + ":" + to;
  const hit = RIDE_MEM.get(id);
  if (hit && Date.now() - hit.at < RIDE_TTL_S * 1000) return hit.minutes;

  const kvKey = "ride:v1:" + id;
  if (env.TIMETABLE) {
    try {
      const k = await env.TIMETABLE.get(kvKey, "json");
      if (k && Number.isFinite(k.minutes)) { RIDE_MEM.set(id, { minutes: k.minutes, at: Date.now() }); return k.minutes; }
    } catch (e) { /* KV trouble just means asking WMATA */ }
  }

  const r = await fetch(
    "https://api.wmata.com/Rail.svc/json/jSrcStationToDstStationInfo?FromStationCode=" + from + "&ToStationCode=" + to,
    { headers: { api_key: env.WMATA_KEY }, cache: "no-store" });
  if (!r.ok) throw new Error("WMATA returned " + r.status + " for the ride time");
  const info = ((await r.json()).StationToStationInfos || [])[0];
  const minutes = info && Number(info.RailTime);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("WMATA gave no ride time for " + from + " to " + to);

  RIDE_MEM.set(id, { minutes, at: Date.now() });
  if (env.TIMETABLE) {
    try { await env.TIMETABLE.put(kvKey, JSON.stringify({ minutes }), { expirationTtl: RIDE_TTL_S }); }
    catch (e) { /* still cached in memory */ }
  }
  return minutes;
}

/* -------------------------- Weather -------------------------- */

// Where each board starts from: Franconia-Springfield and Crystal City.
const PLACES = {
  J03: { name: "Franconia", lat: 38.7663, lon: -77.1680 },
  C09: { name: "Crystal City", lat: 38.8579, lon: -77.0511 },
};
const WX_TTL_MS = 30 * 60000;
const WX_MEM = new Map();

// WMO weather codes, as Open-Meteo reports them, in plain words.
function describe(code) {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 55) return "Drizzle";
  if (code === 56 || code === 57) return "Freezing drizzle";
  if (code === 61) return "Light rain";
  if (code === 63) return "Rain";
  if (code === 65) return "Heavy rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code === 71) return "Light snow";
  if (code === 73) return "Snow";
  if (code === 75) return "Heavy snow";
  if (code === 77) return "Snow grains";
  if (code >= 80 && code <= 82) return "Showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code === 95) return "Thunderstorms";
  if (code === 96 || code === 99) return "Thunderstorms with hail";
  return "—";
}

/**
 * Today's forecast for a station, from Open-Meteo (free, no key):
 * { place, today: { hi, lo, rain, summary }, hours: [{ at, temp, rain, summary }] }
 * `at` is epoch ms; temperatures in °F; `rain` is chance of precipitation in %.
 */
export async function forecast(station) {
  const place = PLACES[station];
  if (!place) throw new Error("no forecast location for " + station);
  const hit = WX_MEM.get(station);
  if (hit && Date.now() - hit.at < WX_TTL_MS) return hit.data;

  const p = new URLSearchParams({
    latitude: String(place.lat), longitude: String(place.lon),
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    hourly: "temperature_2m,precipitation_probability,weather_code",
    temperature_unit: "fahrenheit", timezone: "America/New_York",
    timeformat: "unixtime", forecast_days: "2",
  });
  const r = await fetch("https://api.open-meteo.com/v1/forecast?" + p, { cf: { cacheTtl: 1800 } });
  if (!r.ok) throw new Error("Open-Meteo returned " + r.status);
  const j = await r.json();
  const d = j.daily || {}, h = j.hourly || {};
  const round = v => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

  const data = {
    place: place.name,
    today: {
      hi: round((d.temperature_2m_max || [])[0]),
      lo: round((d.temperature_2m_min || [])[0]),
      rain: round((d.precipitation_probability_max || [])[0]),
      summary: describe((d.weather_code || [])[0]),
    },
    // The next 18 hours, so a train late tonight still finds its hour.
    hours: (h.time || []).map((t, i) => ({
      at: Number(t) * 1000,
      temp: round((h.temperature_2m || [])[i]),
      rain: round((h.precipitation_probability || [])[i]),
      summary: describe((h.weather_code || [])[i]),
    })).filter(x => x.at >= Date.now() - 3600000).slice(0, 18),
  };
  if (data.today.hi == null && !data.hours.length) throw new Error("Open-Meteo returned no forecast");
  WX_MEM.set(station, { data, at: Date.now() });
  return data;
}
