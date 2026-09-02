// VRE support.
//
// WMATA hands us JSON. VRE publishes the transit-industry standard instead:
// a zipped CSV timetable (GTFS) plus a Protocol Buffers realtime feed
// (GTFS-Realtime). Neither is something a browser or Worker reads natively,
// so this file contains a small ZIP reader, a CSV parser, and a minimal
// protobuf decoder. No npm dependencies — everything here uses built-ins.

export const VRE_GTFS = "https://gtfs.vre.org/containercdngtfsupload/google_transit.zip";
export const VRE_TRIPS = "https://gtfs.vre.org/containercdngtfsupload/TripUpdateFeed";

/* ================================================================== *
 * ZIP
 * ================================================================== */

const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

// Returns a map of filename -> Uint8Array for the files you ask for.
// Everything else in the archive is skipped without being decompressed,
// which matters: shapes.txt is by far the largest file and we never need it.
export async function readZip(buf, wanted) {
  const b = new Uint8Array(buf);
  const d = dv(b);

  // End of central directory: scan backwards for the signature.
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
    if (d.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory)");

  const count = d.getUint16(eocd + 10, true);
  let p = d.getUint32(eocd + 16, true);

  const out = {};
  for (let i = 0; i < count; i++) {
    if (d.getUint32(p, true) !== 0x02014b50) break;
    const method = d.getUint16(p + 10, true);
    const compSize = d.getUint32(p + 20, true);
    const nameLen = d.getUint16(p + 28, true);
    const extraLen = d.getUint16(p + 30, true);
    const cmtLen = d.getUint16(p + 32, true);
    const localOff = d.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;

    const base = name.split("/").pop();
    if (wanted && !wanted.includes(base)) continue;

    // The local header repeats the name/extra lengths and they can differ
    // from the central directory's, so re-read them here.
    if (d.getUint32(localOff, true) !== 0x04034b50) continue;
    const lNameLen = d.getUint16(localOff + 26, true);
    const lExtraLen = d.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = b.subarray(start, start + compSize);

    out[base] = method === 0 ? raw : await inflateRaw(raw);
  }
  return out;
}

async function inflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ================================================================== *
 * CSV  (GTFS quoting rules: double quotes, "" escapes a quote)
 * ================================================================== */

export function parseCsv(bytes) {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  const rows = [];
  let field = "", row = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  const head = rows[0].map(h => h.trim().replace(/^\uFEFF/, ""));
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length === 1 && rows[i][0] === "") continue;
    const o = {};
    for (let j = 0; j < head.length; j++) o[head[j]] = (rows[i][j] ?? "").trim();
    out.push(o);
  }
  return out;
}

/* ================================================================== *
 * Protocol Buffers — just enough to walk a GTFS-Realtime FeedMessage
 * ================================================================== */

function decodeFields(b, start = 0, end = b.length) {
  const out = {};
  let p = start;
  const varint = () => {
    let shift = 0, val = 0;
    while (p < end) {
      const byte = b[p++];
      val += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return val;
  };
  while (p < end) {
    const tag = varint();
    if (!tag) break;
    const field = tag >>> 3, wire = tag & 7;
    let v;
    if (wire === 0) v = varint();
    else if (wire === 1) { v = b.subarray(p, p + 8); p += 8; }
    else if (wire === 2) { const len = varint(); v = b.subarray(p, p + len); p += len; }
    else if (wire === 5) { v = b.subarray(p, p + 4); p += 4; }
    else break;
    (out[field] = out[field] || []).push(v);
  }
  return out;
}

const sub = v => decodeFields(v);
const str = v => (v == null ? undefined : new TextDecoder().decode(v));
// protobuf int32 fields carry negative numbers as 10-byte varints
const int32 = v => (v == null ? undefined : (v > 0x7fffffff ? v - 0x10000000000000000 : v));

// -> [{ tripId, routeId, stops: { <stop_id>: {delay, time, seq} }, delay }]
export function parseTripUpdates(bytes) {
  const feed = decodeFields(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const trips = [];
  for (const ent of feed[2] || []) {          // FeedMessage.entity
    const e = sub(ent);
    if (!e[3]) continue;                       // FeedEntity.trip_update
    const tu = sub(e[3][0]);
    const td = tu[1] ? sub(tu[1][0]) : {};     // TripUpdate.trip
    const rec = {
      tripId: str(td[1]?.[0]),                 // TripDescriptor.trip_id
      routeId: str(td[5]?.[0]),                // TripDescriptor.route_id
      startDate: str(td[3]?.[0]),
      delay: int32(tu[5]?.[0]),                // TripUpdate.delay
      stops: {},
    };
    for (const stuRaw of tu[2] || []) {        // TripUpdate.stop_time_update
      const s = sub(stuRaw);
      const seq = s[1]?.[0];
      const stopId = str(s[4]?.[0]);
      const dep = s[3] ? sub(s[3][0]) : (s[2] ? sub(s[2][0]) : null); // departure, else arrival
      if (!stopId && seq == null) continue;
      rec.stops[stopId ?? "seq:" + seq] = {
        seq,
        delay: dep ? int32(dep[1]?.[0]) : undefined,   // StopTimeEvent.delay
        time: dep && dep[2] ? dep[2][0] : undefined,   // StopTimeEvent.time (epoch seconds)
      };
    }
    trips.push(rec);
  }
  return trips;
}

/* ================================================================== *
 * Eastern time helpers — GTFS times are local, and can exceed 24:00
 * ================================================================== */

const TZ = "America/New_York";
function tzParts(t) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const o = {};
  for (const part of f.formatToParts(new Date(t))) {
    if (part.type !== "literal") o[part.type] = part.type === "weekday" ? part.value : +part.value;
  }
  if (o.hour === 24) o.hour = 0;
  return o;
}
function tzOffset(t) {
  const p = tzParts(t);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
}
export function easternNow(t = Date.now()) { return tzParts(t); }

// "16:35:00" -> seconds since midnight; handles 25:10:00 for after-midnight trips
function hmsToSec(s) {
  const m = /^(\d+):(\d+):(\d+)$/.exec(s || "");
  if (!m) return null;
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}
// Midnight Eastern on the given date. Two passes so the offset is
// correct on the days DST shifts.
function serviceDateEpoch(p) {
  const wall = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  let t = wall - tzOffset(wall);
  t = wall - tzOffset(t);
  return t;
}
const yyyymmdd = p => `${p.year}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}`;

/* ================================================================== *
 * Schedule
 * ================================================================== */

let CACHE = null, CACHE_AT = 0;
const SIX_HOURS = 6 * 3600 * 1000;

export async function loadSchedule(force = false) {
  if (!force && CACHE && Date.now() - CACHE_AT < SIX_HOURS) return CACHE;
  const r = await fetch(VRE_GTFS, { cf: { cacheTtl: 21600, cacheEverything: true } });
  if (!r.ok) throw new Error("GTFS zip " + r.status);
  const files = await readZip(await r.arrayBuffer(),
    ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"]);

  const sched = {
    stops: parseCsv(files["stops.txt"] || ""),
    routes: parseCsv(files["routes.txt"] || ""),
    trips: parseCsv(files["trips.txt"] || ""),
    calendar: parseCsv(files["calendar.txt"] || ""),
    calendarDates: parseCsv(files["calendar_dates.txt"] || ""),
    byTrip: {},
  };
  for (const st of parseCsv(files["stop_times.txt"] || "")) {
    (sched.byTrip[st.trip_id] = sched.byTrip[st.trip_id] || []).push({
      stop_id: st.stop_id,
      seq: +st.stop_sequence,
      dep: hmsToSec(st.departure_time || st.arrival_time),
      arr: hmsToSec(st.arrival_time || st.departure_time),
    });
  }
  for (const k in sched.byTrip) sched.byTrip[k].sort((a, b) => a.seq - b.seq);

  CACHE = sched; CACHE_AT = Date.now();
  return sched;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function servicesOn(sched, parts) {
  const date = yyyymmdd(parts);
  const dow = DAYS[WD[parts.weekday]];
  const on = new Set();
  for (const c of sched.calendar) {
    if (c[dow] === "1" && date >= c.start_date && date <= c.end_date) on.add(c.service_id);
  }
  for (const e of sched.calendarDates) {
    if (e.date !== date) continue;
    if (e.exception_type === "1") on.add(e.service_id);
    if (e.exception_type === "2") on.delete(e.service_id);
  }
  return on;
}

const norm = t => (t || "").toLowerCase().replace(/[^a-z]/g, "");

// Match a station by name. Exact first; a contains-match only as fallback,
// and only for queries long enough to be meaningful. Blank names never match
// — a stop with no name would otherwise match every query and drag trips
// from the wrong line onto the board.
function matchStops(sched, name) {
  const n = norm(name);
  if (n.length < 3) return new Set();
  const exact = new Set(), loose = new Set();
  for (const s of sched.stops) {
    // skip entrances, boarding areas and generic nodes
    if (s.location_type && s.location_type !== "0" && s.location_type !== "1") continue;
    const sn = norm(s.stop_name);
    if (!sn) continue;
    if (sn === n) exact.add(s.stop_id);
    else if (sn.includes(n) || (n.includes(sn) && sn.length >= 5)) loose.add(s.stop_id);
  }
  return exact.size ? exact : loose;
}

// Match a route by long name, short name or id.
function matchRoutes(sched, want) {
  if (!want) return null;
  const w = norm(want);
  const ids = new Set();
  for (const r of sched.routes) {
    if ([r.route_long_name, r.route_short_name, r.route_id].some(v => norm(v).includes(w))) {
      ids.add(r.route_id);
    }
  }
  return ids.size ? ids : null;
}

/**
 * Next departures from one VRE station to another, schedule adjusted by
 * the realtime feed. Looks at today and, near midnight, yesterday's
 * after-midnight trips.
 */
export async function vreDepartures({ from, to, route = null, limit = 4, now = Date.now() }) {
  const sched = await loadSchedule();
  const updates = await fetchTripUpdates();
  const byTripId = {};
  for (const u of updates) if (u.tripId) byTripId[u.tripId] = u;

  const fromIds = matchStops(sched, from), toIds = matchStops(sched, to);
  if (!fromIds.size) {
    return { error: "origin station not found in the VRE feed", from,
             available: sched.stops.map(s => s.stop_name).filter(Boolean) };
  }
  const routeIds = matchRoutes(sched, route);

  const routeName = {};
  for (const r of sched.routes) routeName[r.route_id] = r.route_long_name || r.route_short_name || r.route_id;
  const stopName = {};
  for (const st of sched.stops) stopName[st.stop_id] = st.stop_name;

  // Rather than show an empty board, relax one constraint at a time and say
  // which one had to go. An unexpected feed shape then degrades into slightly
  // less precise information instead of a blank panel.
  const attempts = [
    { mode: "filtered",    routeIds, requireDest: true,  requireDirection: true },
    { mode: "either-way",  routeIds, requireDest: true,  requireDirection: false },
    { mode: "any-line",    routeIds: null, requireDest: true,  requireDirection: true },
    { mode: "all-departures", routeIds: null, requireDest: false, requireDirection: false },
  ];

  let last = null;
  for (const a of attempts) {
    if (a.requireDest && !toIds.size) continue;
    const found = scan(sched, byTripId, fromIds, toIds, a, routeName, stopName, now, limit);
    last = { ...found, mode: a.mode };
    if (found.departures.length) break;
  }

  const departures = last ? last.departures : [];

  // When the board is empty, say why. An empty list with no explanation is
  // indistinguishable from "service has finished for the day".
  let diag = null;
  if (!departures.length) {
    const parts = easternNow(now);
    const active = servicesOn(sched, parts);
    const range = sched.calendar.reduce((a, c) => ({
      start: !a.start || c.start_date < a.start ? c.start_date : a.start,
      end: !a.end || c.end_date > a.end ? c.end_date : a.end,
    }), { start: null, end: null });
    const today = yyyymmdd(parts);
    diag = {
      today,
      weekday: parts.weekday,
      trips: sched.trips.length,
      tripsWithStopTimes: Object.keys(sched.byTrip).length,
      calendarRows: sched.calendar.length,
      calendarDateRows: sched.calendarDates.length,
      calendarRange: range,
      feedExpired: !!(range.end && today > range.end),
      feedNotYetStarted: !!(range.start && today < range.start),
      servicesActiveToday: active.size,
      tripsFromOrigin: countFromOrigin(sched, fromIds),
      realtimeTrips: updates.length,
    };
  }

  return {
    from, to, route,
    mode: last ? last.mode : "none",
    departures,
    diag,
    matchedFrom: [...fromIds].map(id => ({ id, name: stopName[id] })),
    matchedTo: [...toIds].map(id => ({ id, name: stopName[id] })),
    routeMatched: routeIds ? [...routeIds] : null,
    feedTrips: updates.length,
  };
}

function countFromOrigin(sched, fromIds) {
  let n = 0;
  for (const trip of sched.trips) {
    const st = sched.byTrip[trip.trip_id];
    if (st && st.some(x => fromIds.has(x.stop_id))) n++;
  }
  return n;
}

function scan(sched, byTripId, fromIds, toIds, opt, routeName, stopName, now, limit) {
  const seen = new Map();
  for (const dayShift of [-1, 0, 1]) {
    const parts = easternNow(now + dayShift * 86400000);
    const active = servicesOn(sched, parts);
    if (!active.size) continue;
    const midnight = serviceDateEpoch(parts);
    const serviceDate = yyyymmdd(parts);

    for (const trip of sched.trips) {
      if (!active.has(trip.service_id)) continue;
      if (opt.routeIds && !opt.routeIds.has(trip.route_id)) continue;
      const stops = sched.byTrip[trip.trip_id];
      if (!stops) continue;

      const o = stops.find(s => fromIds.has(s.stop_id));
      if (!o) continue;

      let dst = null;
      if (opt.requireDest) {
        dst = opt.requireDirection
          ? stops.find(s => toIds.has(s.stop_id) && s.seq > o.seq)
          : stops.find(s => toIds.has(s.stop_id) && s.seq !== o.seq);
        if (!dst) continue;
      }

      const schedEpoch = midnight + o.dep * 1000;
      const u0 = byTripId[trip.trip_id];
      const u = (u0 && (!u0.startDate || u0.startDate === serviceDate)) ? u0 : null;
      let predicted = schedEpoch, delaySec = 0, live = false;
      if (u) {
        const st = u.stops[o.stop_id];
        if (st && st.time) { predicted = st.time * 1000; delaySec = Math.round((predicted - schedEpoch) / 1000); live = true; }
        else if (st && st.delay != null) { delaySec = st.delay; predicted = schedEpoch + delaySec * 1000; live = true; }
        else if (u.delay != null) { delaySec = u.delay; predicted = schedEpoch + delaySec * 1000; live = true; }
      }
      if (predicted < now - 120000) continue;

      const prev = seen.get(trip.trip_id);
      if (prev && prev.predicted <= predicted) continue;
      seen.set(trip.trip_id, {
        tripId: trip.trip_id,
        train: trip.trip_short_name || trip.trip_id,
        line: routeName[trip.route_id] || "VRE",
        headsign: trip.trip_headsign || "",
        // last stop, so an unfiltered result still says where the train goes
        terminus: stopName[stops[stops.length - 1].stop_id] || "",
        scheduled: schedEpoch,
        predicted,
        delaySec, live,
        arrivesAt: dst ? stopName[dst.stop_id] : null,
        arrives: dst ? midnight + dst.arr * 1000 + (live ? delaySec * 1000 : 0) : null,
        outbound: dst ? dst.seq > o.seq : null,
      });
    }
    if (seen.size >= limit && dayShift >= 0) break;
  }
  const departures = [...seen.values()].sort((a, b) => a.predicted - b.predicted).slice(0, limit);
  return { departures };
}

async function fetchTripUpdates() {
  try {
    const r = await fetch(VRE_TRIPS, { cf: { cacheTtl: 20, cacheEverything: true } });
    if (!r.ok) return [];
    return parseTripUpdates(new Uint8Array(await r.arrayBuffer()));
  } catch (e) {
    return [];   // schedule-only is still useful
  }
}


/* ================================================================== *
 * Diagnostics — reports every filtering stage so a "no trains" answer
 * can be traced to the stage that actually dropped them.
 * ================================================================== */
export async function vreDiagnose({ from, to, route = null, now = Date.now() }) {
  const sched = await loadSchedule();
  const parts = easternNow(now);
  const active = servicesOn(sched, parts);
  const fromIds = matchStops(sched, from), toIds = matchStops(sched, to);
  const routeIds = matchRoutes(sched, route);

  const nameOf = {};
  for (const st of sched.stops) nameOf[st.stop_id] = st.stop_name;

  const stages = { total: 0, onRoute: 0, runningToday: 0, servesOrigin: 0,
                   servesBoth: 0, rightDirection: 0, stillToCome: 0 };
  const midnight = serviceDateEpoch(parts);
  const sample = [];

  for (const trip of sched.trips) {
    stages.total++;
    if (routeIds && !routeIds.has(trip.route_id)) continue;
    stages.onRoute++;
    if (!active.has(trip.service_id)) continue;
    stages.runningToday++;
    const stops = sched.byTrip[trip.trip_id];
    if (!stops) continue;
    const o = stops.find(x => fromIds.has(x.stop_id));
    if (!o) continue;
    stages.servesOrigin++;
    const anyDest = stops.find(x => toIds.has(x.stop_id));
    if (!anyDest) continue;
    stages.servesBoth++;
    const dst = stops.find(x => toIds.has(x.stop_id) && x.seq > o.seq);
    if (!dst) continue;
    stages.rightDirection++;
    const dep = midnight + o.dep * 1000;
    if (dep >= now - 120000) stages.stillToCome++;
    if (sample.length < 12) {
      sample.push({ train: trip.trip_short_name || trip.trip_id, tripId: trip.trip_id,
                    service: trip.service_id, departs: new Date(dep).toISOString(),
                    future: dep >= now - 120000 });
    }
  }

  let rt = [];
  try { rt = await fetchTripUpdatesDiag(); } catch (e) {}

  return {
    easternNow: `${parts.weekday} ${parts.year}-${String(parts.month).padStart(2,"0")}-${String(parts.day).padStart(2,"0")} ${String(parts.hour).padStart(2,"0")}:${String(parts.minute).padStart(2,"0")}`,
    feedCounts: { stops: sched.stops.length, routes: sched.routes.length,
                  trips: sched.trips.length, tripsWithStopTimes: Object.keys(sched.byTrip).length,
                  calendarRows: sched.calendar.length, calendarDateRows: sched.calendarDates.length },
    routes: sched.routes.map(r => ({ id: r.route_id, short: r.route_short_name, long: r.route_long_name })),
    routeQuery: route, routeMatched: routeIds ? [...routeIds] : null,
    servicesActiveToday: [...active],
    stationQuery: { from, to },
    matchedFrom: [...fromIds].map(id => ({ id, name: nameOf[id] })),
    matchedTo: [...toIds].map(id => ({ id, name: nameOf[id] })),
    stages,
    sample,
    realtimeTrips: rt.length,
    realtimeSampleTripIds: rt.slice(0, 5).map(t => t.tripId),
  };
}

async function fetchTripUpdatesDiag() {
  const r = await fetch(VRE_TRIPS, { cf: { cacheTtl: 20 } });
  if (!r.ok) return [];
  return parseTripUpdates(new Uint8Array(await r.arrayBuffer()));
}
