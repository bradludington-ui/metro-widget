// Timetable (GTFS) tests: matching the board's line and direction to WMATA's
// wording, caching, and how refusals are reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { railGtfs, fakeKV, mockFetch, fresh } from "./helpers.mjs";

const AM = { station: "J03", line: "BL", headsign: "Downtown Largo", horizonMin: 60 };
const PM_DIR = { station: "J03", line: "BL", headsign: "Franconia-Springfield", horizonMin: 60 };
const trips = r => r.departures.map(d => d.trip);

test("AM: 'Downtown Largo' matches the feed's 'Largo', Blue Line only, within the horizon", async t => {
  mockFetch(t, () => new Response(railGtfs()));
  const { scheduledDepartures } = await fresh("../schedule.js");
  const r = await scheduledDepartures({ env: { WMATA_KEY: "k" }, ...AM });
  // Not the Red Line trip, not the opposite direction, not the one 200 min out.
  assert.deepEqual(trips(r), ["BL_LARGO_25", "BL_LARGO_40"]);
  assert.equal(r.departures[0].headsign, "Largo", "quotes are stripped");
  assert.equal(r.departures[0].line, "B");
});

test("PM direction: only Franconia-Springfield trips", async t => {
  mockFetch(t, () => new Response(railGtfs()));
  const { scheduledDepartures } = await fresh("../schedule.js");
  assert.deepEqual(trips(await scheduledDepartures({ env: { WMATA_KEY: "k" }, ...PM_DIR })), ["BL_FRANCONIA_30"]);
});

test("departures come back in time order with epochs in the future", async t => {
  mockFetch(t, () => new Response(railGtfs()));
  const { scheduledDepartures } = await fresh("../schedule.js");
  const r = await scheduledDepartures({ env: { WMATA_KEY: "k" }, ...AM });
  const e = r.departures.map(d => d.epoch);
  assert.deepEqual(e, [...e].sort((a, b) => a - b));
  assert.ok(e[0] > Date.now() + 20 * 60000 && e[0] < Date.now() + 30 * 60000, "about 25 minutes out");
});

test("downloads straight from WMATA, never through Cloudflare's shared cache", async t => {
  const calls = mockFetch(t, () => new Response(railGtfs()));
  const { scheduledDepartures } = await fresh("../schedule.js");
  await scheduledDepartures({ env: { WMATA_KEY: "my-key" }, ...AM });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.wmata.com/gtfs/rail-gtfs-static.zip");
  assert.equal(calls[0].init.headers.api_key, "my-key");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.cf, undefined);
});

test("caching: memory, then KV after a restart, and never shared across keys", async t => {
  const calls = mockFetch(t, () => new Response(railGtfs()));
  const kv = fakeKV();
  const env = { WMATA_KEY: "key-A", TIMETABLE: kv };

  let m = await fresh("../schedule.js");
  assert.equal((await m.scheduledDepartures({ env, ...AM })).source, "wmata");
  assert.equal((await m.scheduledDepartures({ env, ...AM })).source, "memory");
  assert.equal(calls.length, 1);

  m = await fresh("../schedule.js");                       // a cold Worker instance
  assert.equal((await m.scheduledDepartures({ env, ...AM })).source, "kv");
  assert.equal(calls.length, 1, "no second download");

  const other = await m.scheduledDepartures({ env: { ...env, WMATA_KEY: "key-B" }, ...AM });
  assert.equal(other.source, "wmata", "a different key gets its own download");
  assert.equal(calls.length, 2);

  for (const [k, v] of kv.store) {
    assert.ok(!k.includes("key-A") && !v.value.includes("key-A"), "the key itself is never stored");
    assert.equal(v.opts.expirationTtl, 12 * 3600);
  }
});

test("works without a KV binding", async t => {
  mockFetch(t, () => new Response(railGtfs()));
  const { scheduledDepartures } = await fresh("../schedule.js");
  const r = await scheduledDepartures({ env: { WMATA_KEY: "k" }, ...AM });
  assert.equal(r.source, "wmata");
  assert.equal(r.departures.length, 2);
});

test("a refused download explains itself and includes WMATA's own words", async t => {
  mockFetch(t, () => new Response('{"message":"Out of call volume quota."}', { status: 403 }));
  const { scheduledDepartures } = await fresh("../schedule.js");
  await assert.rejects(scheduledDepartures({ env: { WMATA_KEY: "k" }, ...AM }), e => {
    assert.ok(e.needsOwnKey);
    assert.match(e.message, /refused the GTFS download \(403\)/);
    assert.match(e.message, /Out of call volume quota/);
    return true;
  });
});

test("diagnostics report where the timetable came from", async t => {
  mockFetch(t, () => new Response(railGtfs()));
  const { scheduleDiagnose } = await fresh("../schedule.js");
  const d = await scheduleDiagnose({ WMATA_KEY: "k" }, "J03");
  assert.equal(d.source, "wmata");
  assert.equal(d.rowsForStation, 5);
  assert.equal(d.headsignsSeen["B → Largo"], 3);
});
