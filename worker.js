// Workers entry point. Serves the /api/ routes itself and hands everything
// else to the static assets (index.html, sw.js, icons).

import { hereTraffic, hereDiagnose } from "./traffic.js";
import { scheduledDepartures, scheduleDiagnose } from "./schedule.js";

// WMATA's old shared demo key no longer works, so without a WMATA_KEY
// secret there is nothing to call with. Say so plainly.
const NO_KEY = "No WMATA key set. Add your key as the WMATA_KEY secret in " +
  "Cloudflare (Workers & Pages → metro-widget → Settings → Variables and Secrets).";
const ALLOWED = new Set(["C09", "J03", "G05", "C08", "C13", "C07"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/trains") {
      return trains(url, env);
    }
    if (url.pathname === "/api/schedule") {
      return schedule(url, env);
    }
    if (url.pathname === "/api/schedule/debug") {
      if (!env.WMATA_KEY) return json({ error: NO_KEY, noKey: true }, 200);
      try { return json(await scheduleDiagnose(env, url.searchParams.get("station") || "C09"), 200); }
      catch (e) { return json({ error: String(e && e.message || e), needsOwnKey: !!e.needsOwnKey }, 200); }
    }
    if (url.pathname === "/api/traffic") {
      return traffic(url, env);
    }
    if (url.pathname === "/api/traffic/debug") {
      return trafficDebug(url, env);
    }
    // Not an API route — let the static assets handle it.
    return env.ASSETS.fetch(request);
  },
};

async function trains(url, env) {
  const station = (url.searchParams.get("station") || "C09").toUpperCase();
  if (!ALLOWED.has(station)) return json({ error: "station not allowed" }, 400);

  if (!env.WMATA_KEY) return json({ error: NO_KEY, noKey: true }, 503);
  const key = env.WMATA_KEY;

  try {
    const r = await fetch(
      `https://api.wmata.com/StationPrediction.svc/json/GetPrediction/${station}`,
      { headers: { api_key: key }, cf: { cacheTtl: 15, cacheEverything: true } }
    );
    if (!r.ok) {
      // Pass WMATA's own explanation through. Without it the board can only
      // say "502", which doesn't tell a bad key from an outage.
      const detail = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      let why;
      if (r.status === 401 || r.status === 403) {
        why = "WMATA rejected your WMATA_KEY (" + r.status + "). Check the secret in Cloudflare matches your primary key.";
      } else if (r.status === 429) {
        why = "WMATA rate limit (429).";
      } else {
        why = "WMATA returned " + r.status + (r.status >= 500 ? " — their API is having trouble." : ".");
      }
      return json({ error: why, wmataStatus: r.status, detail }, r.status === 429 ? 429 : 502);
    }
    return json(await r.json(), 200);
  } catch (e) {
    return json({ error: "Couldn't reach WMATA: " + String(e && e.message || e) }, 502);
  }
}

// Timetable beyond the live prediction horizon. Kept on its own endpoint so
// a GTFS failure can never take the live board down with it.
async function schedule(url, env) {
  const station = (url.searchParams.get("station") || "C09").toUpperCase();
  if (!ALLOWED.has(station)) return json({ error: "station not allowed" }, 400);
  const line = url.searchParams.get("line") || "";
  const headsign = url.searchParams.get("headsign") || "";
  const horizonMin = Math.min(180, Math.max(10, +url.searchParams.get("horizon") || 90));
  if (!env.WMATA_KEY) return json({ error: NO_KEY, noKey: true }, 200);

  try {
    return json(await scheduledDepartures({ env, station, line, headsign, horizonMin }), 200);
  } catch (e) {
    return json({ error: String(e && e.message || e), needsOwnKey: !!e.needsOwnKey }, 200);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=15",
    },
  });
}
