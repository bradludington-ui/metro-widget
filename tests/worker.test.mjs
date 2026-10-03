// Worker tests: every route answers without throwing, missing keys are
// explained, and WMATA failures are reported in plain words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { railGtfs, mockFetch } from "./helpers.mjs";
import worker from "../worker.js";

const ASSETS = { fetch: async req => new Response("asset:" + new URL(req.url).pathname, { status: 404 }) };
const call = async (path, env) => {
  const r = await worker.fetch(new Request("https://board.example" + path), { ASSETS, ...env });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

// The drive page broke because worker.js routed to functions that no longer
// existed. Calling every route, with and without a key, catches that.
test("every route answers, with or without a key", async t => {
  mockFetch(t, url => url.includes("gtfs")
    ? new Response(railGtfs())
    : new Response(JSON.stringify({ Trains: [] })));
  const routes = ["/api/trains?station=J03", "/api/schedule?station=J03&line=BL&headsign=Largo",
                  "/api/schedule/debug?station=J03", "/", "/index.html", "/sw.js"];
  for (const env of [{}, { WMATA_KEY: "k" }]) {
    for (const path of routes) {
      const r = await call(path, env);
      assert.ok(r.status < 500 || r.status === 503, `${path} ${JSON.stringify(env)} -> ${r.status}`);
    }
  }
});

test("no WMATA_KEY: every WMATA route says so, and nothing calls WMATA", async t => {
  const calls = mockFetch(t, () => { throw new Error("should not be called"); });
  const trains = await call("/api/trains?station=J03", {});
  assert.equal(trains.status, 503);
  assert.match(trains.body.error, /No WMATA key set/);
  for (const path of ["/api/schedule?station=J03", "/api/schedule/debug"]) {
    const r = await call(path, {});
    assert.equal(r.body.noKey, true, path);
  }
  assert.equal(calls.length, 0);
});

test("trains: passes WMATA's predictions through", async t => {
  const calls = mockFetch(t, () => new Response(JSON.stringify({ Trains: [{ Line: "BL", Min: "4" }] })));
  const r = await call("/api/trains?station=c09", { WMATA_KEY: "k" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.Trains, [{ Line: "BL", Min: "4" }]);
  assert.match(calls[0].url, /GetPrediction\/C09$/);
  assert.equal(calls[0].init.headers.api_key, "k");
});

test("trains: stations outside the allowed list are refused", async t => {
  const calls = mockFetch(t, () => new Response("{}"));
  assert.equal((await call("/api/trains?station=A01", { WMATA_KEY: "k" })).status, 400);
  assert.equal(calls.length, 0);
});

test("trains: WMATA failures are explained", async t => {
  const cases = [
    [401, 502, /rejected your WMATA_KEY \(401\)/],
    [403, 502, /rejected your WMATA_KEY \(403\)/],
    [429, 429, /rate limit/],
    [503, 502, /having trouble/],
  ];
  for (const [wmata, status, msg] of cases) {
    mockFetch(t, () => new Response("detail text", { status: wmata }));
    const r = await call("/api/trains?station=J03", { WMATA_KEY: "k" });
    assert.equal(r.status, status, `WMATA ${wmata}`);
    assert.match(r.body.error, msg);
    assert.equal(r.body.detail, "detail text");
  }
  mockFetch(t, () => { throw new Error("connection reset"); });
  const r = await call("/api/trains?station=J03", { WMATA_KEY: "k" });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /Couldn't reach WMATA: connection reset/);
});

test("schedule: returns departures for the board", async t => {
  mockFetch(t, () => new Response(railGtfs()));
  const r = await call("/api/schedule?station=J03&line=BL&headsign=Downtown%20Largo&horizon=60", { WMATA_KEY: "k2" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.departures.map(d => d.trip), ["BL_LARGO_25", "BL_LARGO_40"]);
});

test("routes that were removed fall through to the static files", async t => {
  mockFetch(t, () => { throw new Error("should not be called"); });
  for (const path of ["/api/traffic", "/drive.html"]) {
    const r = await call(path, { WMATA_KEY: "k" });
    assert.equal(r.body, "asset:" + path);
  }
});
