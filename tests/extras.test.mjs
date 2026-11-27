// Ride time (for arrival times) and weather routes, with WMATA and
// Open-Meteo faked in the shapes their documentation gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeKV, mockFetch, fresh } from "./helpers.mjs";

const ASSETS = { fetch: async () => new Response("asset", { status: 404 }) };
const call = async (worker, path, env) => {
  const r = await worker.fetch(new Request("https://board.example" + path), { ASSETS, ...env });
  return { status: r.status, body: await r.json() };
};
// A fresh worker (and so a fresh extras.js with empty caches) per test.
const freshWorker = async () => {
  const extras = await fresh("../extras.js");
  return { extras };
};

const wmataRide = minutes => new Response(JSON.stringify({ StationToStationInfos: [
  { SourceStation: "J03", DestinationStation: "C09", RailTime: minutes, CompositeMiles: 9.1, RailFare: {} }] }));

function openMeteo() {
  const start = Math.floor(Date.now() / 3600000) * 3600;      // this hour, unix seconds
  const hours = Array.from({ length: 30 }, (_, i) => start + (i - 2) * 3600);
  return new Response(JSON.stringify({
    daily: { time: [start, start + 86400], temperature_2m_max: [54.4, 50], temperature_2m_min: [37.6, 35],
             precipitation_probability_max: [60, 10], weather_code: [61, 3] },
    hourly: { time: hours, temperature_2m: hours.map((_, i) => 40 + i / 2),
              precipitation_probability: hours.map(() => 35), weather_code: hours.map((_, i) => (i < 5 ? 3 : 61)) },
  }));
}

test("ride: WMATA's scheduled ride time between the board's stations", async t => {
  const calls = mockFetch(t, () => wmataRide(19));
  const { extras } = await freshWorker();
  assert.equal(await extras.rideMinutes({ WMATA_KEY: "k" }, "J03", "C09"), 19);
  assert.match(calls[0].url, /jSrcStationToDstStationInfo\?FromStationCode=J03&ToStationCode=C09$/);
  assert.equal(calls[0].init.headers.api_key, "k");
});

test("ride: cached in memory, then in KV across a restart; failures aren't cached", async t => {
  let fail = true;
  const calls = mockFetch(t, () => (fail ? new Response("down", { status: 503 }) : wmataRide(19)));
  const kv = fakeKV();
  let { extras } = await freshWorker();
  await assert.rejects(extras.rideMinutes({ WMATA_KEY: "k", TIMETABLE: kv }, "J03", "C09"), /503/);
  fail = false;
  assert.equal(await extras.rideMinutes({ WMATA_KEY: "k", TIMETABLE: kv }, "J03", "C09"), 19);
  assert.equal(await extras.rideMinutes({ WMATA_KEY: "k", TIMETABLE: kv }, "J03", "C09"), 19);
  assert.equal(calls.length, 2, "one failure, one success, then memory");
  ({ extras } = await freshWorker());
  assert.equal(await extras.rideMinutes({ WMATA_KEY: "k", TIMETABLE: kv }, "J03", "C09"), 19);
  assert.equal(calls.length, 2, "a restart reads KV, not WMATA");
});

test("ride route: only the board's two stations, and needs a key", async t => {
  mockFetch(t, () => wmataRide(19));
  const worker = (await import("../worker.js")).default;
  assert.equal((await call(worker, "/api/ride?from=J03&to=G05", { WMATA_KEY: "k" })).status, 400);
  assert.equal((await call(worker, "/api/ride?from=J03&to=J03", { WMATA_KEY: "k" })).status, 400);
  assert.equal((await call(worker, "/api/ride?from=J03&to=C09", {})).body.noKey, true);
  const ok = await call(worker, "/api/ride?from=c09&to=j03", { WMATA_KEY: "k" });
  assert.deepEqual(ok.body, { from: "C09", to: "J03", minutes: 19 });
});

test("weather: today's range and the coming hours, in plain words", async t => {
  const calls = mockFetch(t, () => openMeteo());
  const { extras } = await freshWorker();
  const w = await extras.forecast("J03");
  assert.equal(w.place, "Franconia");
  assert.deepEqual(w.today, { hi: 54, lo: 38, rain: 60, summary: "Light rain" });
  assert.ok(w.hours.length > 0 && w.hours.length <= 18);
  assert.ok(w.hours[0].at >= Date.now() - 3600000, "no hours from earlier than the last hour");
  assert.equal(typeof w.hours[0].temp, "number");
  assert.ok(["Cloudy", "Light rain"].includes(w.hours[0].summary));
  const u = new URL(calls[0].url);
  assert.equal(u.hostname, "api.open-meteo.com");
  assert.equal(u.searchParams.get("temperature_unit"), "fahrenheit");
  assert.equal(u.searchParams.get("latitude"), "38.7663");
  await extras.forecast("J03");
  assert.equal(calls.length, 1, "cached for 30 minutes");
});

test("weather route: known stations only; errors are reported, not thrown", async t => {
  mockFetch(t, () => new Response("nope", { status: 500 }));
  const worker = (await import("../worker.js")).default;
  assert.equal((await call(worker, "/api/weather?station=A01", {})).status, 400);
  const r = await call(worker, "/api/weather?station=C09", {});
  assert.equal(r.status, 200);
  assert.match(r.body.error, /Open-Meteo returned 500/);
});
