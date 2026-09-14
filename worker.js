// Workers entry point. Serves /api/trains itself and hands everything
// else to the static assets (index.html, sw.js, icons).
//
// This is the Workers equivalent of functions/api/trains.js — keep whichever
// one matches how you deployed. Having both in the repo is harmless.

import { hereTraffic, hereDiagnose } from "./traffic.js";
import { scheduledDepartures, scheduleDiagnose } from "./schedule.js";

const DEMO_KEY = "e13626d03d8e4c03ac07f95541b3091b";
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
      const key = env.WMATA_KEY || DEMO_KEY;
      try { return json(await scheduleDiagnose(key, url.searchParams.get("station") || "C09"), 200); }
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

  const key = env.WMATA_KEY || DEMO_KEY;
  const usingDemo = !env.WMATA_KEY;

  try {
    const r = await fetch(
      `https://api.wmata.com/StationPrediction.svc/json/GetPrediction/${station}`,
      { headers: { api_key: key }, cf: { cacheTtl: 15, cacheEverything: true } }
    );
    if (!r.ok) return json({ error: "wmata " + r.status, usingDemo }, 502);
    const data = await r.json();
    data.usingDemoKey = usingDemo;
    return json(data, 200);
  } catch (e) {
    return json({ error: String(e), usingDemo }, 502);
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
  const key = env.WMATA_KEY || DEMO_KEY;

  try {
    const r = await scheduledDepartures({ key, station, line, headsign, horizonMin });
    return json({ usingDemoKey: !env.WMATA_KEY, ...r }, 200);
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
