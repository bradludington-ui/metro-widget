// Shared test helpers: a tiny GTFS zip builder and fake Cloudflare bindings.
// Everything here uses Node built-ins only, so `node --test` needs no install.

const enc = new TextEncoder();

// Build an uncompressed (stored) zip. schedule.js reads method 0 directly and
// doesn't check CRCs, so they're left as zero.
export function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name), data = enc.encode(text);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(local.buffer), nameB, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameB.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cenSize = central.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

// GTFS departure time `minutes` from now, in WMATA's (Eastern) service day.
// Hours may pass 24, as GTFS allows, so the fixture works near midnight.
export function gtfsTimeIn(minutes) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const sec = (+parts.hour % 24) * 3600 + +parts.minute * 60 + +parts.second + minutes * 60;
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return [h, m, s].map(n => String(n).padStart(2, "0")).join(":");
}

// A WMATA-shaped rail GTFS feed for Franconia-Springfield (J03): quoted
// fields, a "B" short name for the Blue Line, a Red Line trip, and both
// directions. Trip ids say what each one is. `extra` adds more trips:
// [{ trip, route, headsign, time }], with `time` a GTFS time string.
export function railGtfs(extra = []) {
  const t = gtfsTimeIn;
  return makeZip({
    "routes.txt":
      'route_id,route_short_name,route_long_name\r\n"BLUE","B",""\r\n"RED","R",""\r\n',
    "trips.txt":
      'route_id,service_id,trip_id,trip_headsign\r\n' +
      '"BLUE","ALL","BL_LARGO_25","Largo"\r\n' +
      '"BLUE","ALL","BL_FRANCONIA_30","Franconia-Springfield"\r\n' +
      '"BLUE","ALL","BL_LARGO_40","Largo"\r\n' +
      '"RED","ALL","RD_LARGO_35","Largo"\r\n' +
      '"BLUE","ALL","BL_LARGO_200","Largo"\r\n' +
      extra.map(x => `"${x.route}","ALL","${x.trip}","${x.headsign}"\r\n`).join(""),
    "stop_times.txt":
      'trip_id,arrival_time,departure_time,stop_id,stop_sequence\r\n' +
      `"BL_LARGO_25","${t(25)}","${t(25)}","PF_J03_C","1"\r\n` +
      `"BL_FRANCONIA_30","${t(30)}","${t(30)}","PF_J03_C","20"\r\n` +
      `"BL_LARGO_40","${t(40)}","${t(40)}","PF_J03_C","1"\r\n` +
      `"RD_LARGO_35","${t(35)}","${t(35)}","PF_J03_C","1"\r\n` +
      `"BL_LARGO_200","${t(200)}","${t(200)}","PF_J03_C","1"\r\n` +
      extra.map(x => `"${x.trip}","${x.time}","${x.time}","PF_J03_C","1"\r\n`).join(""),
    "calendar.txt":
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\r\n' +
      '"ALL","1","1","1","1","1","1","1","20000101","20991231"\r\n',
    "calendar_dates.txt": "service_id,date,exception_type\r\n",
  });
}

// In-memory stand-in for a Workers KV namespace.
export function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) { const v = store.get(k); return v == null ? null : (type === "json" ? JSON.parse(v.value) : v.value); },
    async put(k, value, opts) { store.set(k, { value, opts }); },
  };
}

// Replace global fetch for the duration of a test; returns the call log.
export function mockFetch(t, handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

// Import a fresh copy of a module, so its in-memory caches start empty.
export const fresh = path => import(new URL(path, import.meta.url).href + "?" + Math.random());
