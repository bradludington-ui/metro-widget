// WMATA rail timetable (GTFS static).
//
// The real-time API only reports trains WMATA is actively tracking — about
// 15-20 minutes out. To fill a board an hour deep we need the published
// timetable, which comes as a zip of CSVs.
//
// The expensive part is stop_times.txt: tens of thousands of rows for the
// whole rail network. We only ever care about two stations, so the scan
// keeps just the matching lines and never builds objects for the rest.

const GTFS_URL = "https://api.wmata.com/gtfs/rail-gtfs-static.zip";
const TTL_MS = 12 * 3600 * 1000;

/* ---------------------------- ZIP ---------------------------- */

async function readZip(buf, wanted) {
  const b = new Uint8Array(buf);
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);

  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 66000; i--) {
    if (d.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip");

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

/* ---------------------------- CSV ---------------------------- */

function parseCsv(bytes) {
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

/* ------------------------ Eastern time ------------------------ */

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
function midnightEastern(p) {
  const wall = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  let t = wall - tzOffset(wall);
  return wall - tzOffset(t);
}
const yyyymmdd = p =>
  `${p.year}${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}`;
const hmsToSec = s => {
  const m = /^(\d+):(\d+):(\d+)$/.exec(s || "");
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
};

const norm = t => (t || "").toLowerCase().replace(/[^a-z]/g, "");

/* --------------------------- Feed ---------------------------- */

let CACHE = null, CACHE_AT = 0, CACHE_STATIONS = "";

/**
 * Build a small index for just the stations we care about.
 * stations: array of WMATA codes, e.g. ["C09","J03"]. WMATA's GTFS uses
 * platform-level stop ids that embed the station code, so a substring
 * match catches every platform without needing the station hierarchy.
 */
export async function loadRailSchedule(key, stations, force = false) {
  const tag = stations.slice().sort().join(",");
  if (!force && CACHE && CACHE_STATIONS === tag && Date.now() - CACHE_AT < TTL_MS) return CACHE;

  const r = await fetch(GTFS_URL, {
    headers: { api_key: key },
    cf: { cacheTtl: 43200, cacheEverything: true },
  });
  if (r.status === 401 || r.status === 403) {
    const e = new Error("WMATA refused the GTFS download (" + r.status +
      "). The GTFS feed is a separate subscription from the Default Tier — " +
      "the shared demo key usually can't reach it.");
    e.needsOwnKey = true;
    throw e;
  }
  if (!r.ok) throw new Error("GTFS download " + r.status);

  const files = await readZip(await r.arrayBuffer(),
    ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"]);

  const routeName = {}, routeMatch = {};
  for (const x of parseCsv(files["routes.txt"] || "")) {
    routeName[x.route_id] = x.route_short_name || x.route_long_name || x.route_id;
    // Match on short name, long name and id together: WMATA's short name is
    // "BL" while the line is spoken of as "Blue", and either may be asked for.
    routeMatch[x.route_id] = norm([x.route_short_name, x.route_long_name, x.route_id].join(" "));
  }

  // trips.txt is thousands of rows; a line scan avoids building an object
  // per row the way a general CSV parse would.
  const trips = {};
  {
    const tt = new TextDecoder().decode(files["trips.txt"] || new Uint8Array());
    const nl0 = tt.indexOf("\n");
    const h = tt.slice(0, nl0).replace(/\uFEFF/g, "").trim().split(",");
    const iR = h.indexOf("route_id"), iS = h.indexOf("service_id");
    const iT = h.indexOf("trip_id"), iH = h.indexOf("trip_headsign");
    let q = nl0 + 1;
    while (q < tt.length) {
      let e = tt.indexOf("\n", q);
      if (e < 0) e = tt.length;
      const c = tt.slice(q, e).split(",");
      q = e + 1;
      if (c.length <= iT || !c[iT]) continue;
      trips[c[iT]] = {
        route: routeName[c[iR]] || c[iR],
        match: routeMatch[c[iR]] || norm(c[iR]),
        service: c[iS],
        headsign: iH >= 0 ? (c[iH] || "") : "",
      };
    }
  }

  // Targeted scan. Tens of thousands of rows, but a cheap substring test
  // rejects nearly all of them before any splitting happens.
  const text = new TextDecoder().decode(files["stop_times.txt"] || new Uint8Array());
  const nl = text.indexOf("\n");
  const head = text.slice(0, nl).replace(/\uFEFF/g, "").trim().split(",");
  const iTrip = head.indexOf("trip_id");
  const iDep = head.indexOf("departure_time");
  const iStop = head.indexOf("stop_id");
  const iSeq = head.indexOf("stop_sequence");

  const byStation = {};
  for (const code of stations) byStation[code] = [];

  let pos = nl + 1;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    for (const code of stations) {
      if (line.indexOf(code) === -1) continue;
      const c = line.split(",");
      if (!c[iStop] || c[iStop].indexOf(code) === -1) break;   // matched elsewhere in the row
      const dep = hmsToSec(c[iDep]);
      if (dep === null) break;
      byStation[code].push({ trip: c[iTrip], dep, seq: +c[iSeq] });
      break;
    }
  }

  CACHE = {
    trips,
    byStation,
    calendar: parseCsv(files["calendar.txt"] || ""),
    calendarDates: parseCsv(files["calendar_dates.txt"] || ""),
    builtAt: Date.now(),
  };
  CACHE_AT = Date.now(); CACHE_STATIONS = tag;
  return CACHE;
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

/**
 * Scheduled departures from one station, filtered by line and by the
 * headsign that establishes direction.
 */
export async function scheduledDepartures({ key, station, line, headsign,
                                            now = Date.now(), horizonMin = 90, limit = 20 }) {
  const sched = await loadRailSchedule(key, [station]);
  const wantLine = norm(line), wantHead = norm(headsign);
  const out = [];

  for (const shift of [0, 1]) {          // today, plus tomorrow near midnight
    const parts = tzParts(now + shift * 86400000);
    const active = servicesOn(sched, parts);
    if (!active.size) continue;
    const midnight = midnightEastern(parts);

    for (const row of sched.byStation[station] || []) {
      const t = sched.trips[row.trip];
      if (!t || !active.has(t.service)) continue;
      if (wantLine && t.match.indexOf(wantLine) === -1) continue;
      if (wantHead && norm(t.headsign).indexOf(wantHead) === -1) continue;
      const epoch = midnight + row.dep * 1000;
      if (epoch < now) continue;
      if (epoch > now + horizonMin * 60000) continue;
      out.push({ epoch, trip: row.trip, line: t.route, headsign: t.headsign });
    }
    if (out.length >= limit) break;
  }

  out.sort((a, b) => a.epoch - b.epoch);
  return { departures: out.slice(0, limit), builtAt: sched.builtAt };
}

// Diagnostic: how much of the feed did we actually index?
export async function scheduleDiagnose(key, station) {
  const sched = await loadRailSchedule(key, [station]);
  const parts = tzParts(Date.now());
  const active = servicesOn(sched, parts);
  const rows = sched.byStation[station] || [];
  const heads = {};
  for (const r of rows.slice(0, 4000)) {
    const t = sched.trips[r.trip];
    if (t) heads[t.route + " → " + t.headsign] = (heads[t.route + " → " + t.headsign] || 0) + 1;
  }
  return {
    today: yyyymmdd(parts), weekday: parts.weekday,
    tripsInFeed: Object.keys(sched.trips).length,
    rowsForStation: rows.length,
    servicesActiveToday: active.size,
    headsignsSeen: heads,
  };
}
