// Workers entry point. Serves /api/trains itself and hands everything
// else to the static assets (index.html, sw.js, icons).
//
// This is the Workers equivalent of functions/api/trains.js — keep whichever
// one matches how you deployed. Having both in the repo is harmless.

import { vreDepartures, vreDiagnose, loadSchedule } from "./vre.js";
import { hereTraffic, hereDiagnose } from "./traffic.js";

const DEMO_KEY = "e13626d03d8e4c03ac07f95541b3091b";
const ALLOWED = new Set(["C09", "J03", "G05", "C08", "C13", "C07"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/trains") {
      return trains(url, env);
    }
    if (url.pathname === "/api/traffic") {
      return traffic(url, env);
    }
    if (url.pathname === "/api/traffic/debug") {
      return trafficDebug(url, env);
    }
    if (url.pathname === "/api/vre") {
      return vre(url);
    }
    if (url.pathname === "/api/vre/debug") {
      const from = url.searchParams.get("from") || "Crystal City";
      const to = url.searchParams.get("to") || "Franconia-Springfield";
      const route = url.searchParams.get("route");   // omit to test without the line filter
      try { return json(await vreDiagnose({ from, to, route }), 200); }
      catch (e) { return json({ error: String(e && e.message || e) }, 502); }
    }
    if (url.pathname === "/api/vre/stations") {
      return vreStations();          // for checking how VRE spells things
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

// VRE publishes GTFS + GTFS-Realtime openly, so there's no key to manage —
// but both are binary formats the browser can't read, which is why this
// runs server-side. See vre.js.
async function vre(url) {
  const from = url.searchParams.get("from") || "Crystal City";
  const to = url.searchParams.get("to") || "Franconia-Springfield";
  const route = url.searchParams.get("route") || null;
  const limit = Math.min(6, Math.max(1, +url.searchParams.get("limit") || 3));
  try {
    return json(await vreDepartures({ from, to, route, limit }), 200);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}

// Diagnostic: what station names does the VRE feed actually use?
async function vreStations() {
  try {
    const s = await loadSchedule();
    return json({
      stations: s.stops.map(x => ({ id: x.stop_id, name: x.stop_name })),
      routes: s.routes.map(r => r.route_long_name || r.route_short_name),
    }, 200);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
}

/* ------------------------------------------------------------------ *
 * Traffic — HERE.
 * Live traffic is commercial data, so unlike WMATA and VRE this needs a key.
 * Set HERE_KEY in the Worker's Variables and Secrets.
 * ------------------------------------------------------------------ */
const LL = /^-?\d+\.?\d*,-?\d+\.?\d*$/;
const DEFAULT_FROM = "38.7057,-77.2247";   // I-95 Exit 163, Lorton
const DEFAULT_TO   = "38.8719,-77.0563";   // The Pentagon

async function traffic(url, env) {
  if (!env.HERE_KEY) {
    return json({ error: "no_key", wanted: "HERE_KEY",
      message: "Set HERE_KEY in the Worker's Variables and Secrets. " +
               "Free key at developer.here.com." }, 200);
  }
  const from = url.searchParams.get("from") || DEFAULT_FROM;
  const to   = url.searchParams.get("to")   || DEFAULT_TO;
  if (!LL.test(from) || !LL.test(to)) return json({ error: "from and to must be lat,lon" }, 400);

  try {
    const data = await hereTraffic(env.HERE_KEY, from, to);
    return json({ generated: Date.now(), from, to, ...data }, 200);
  } catch (e) {
    // Pass HERE's own error text through — its 400s name the bad parameter.
    return json({ error: String(e && e.message || e), attempts: e && e.attempts }, 200);
  }
}

// Every request tier, with status and HERE's raw response.
async function trafficDebug(url, env) {
  if (!env.HERE_KEY) return json({ error: "HERE_KEY is not set" }, 200);
  const from = url.searchParams.get("from") || DEFAULT_FROM;
  const to   = url.searchParams.get("to")   || DEFAULT_TO;
  try { return json(await hereDiagnose(env.HERE_KEY, from, to), 200); }
  catch (e) { return json({ error: String(e && e.message || e) }, 200); }
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
