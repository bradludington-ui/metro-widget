// Traffic via HERE.
//
// HERE Routing v8 attaches incidents to the route itself and names the roads
// in each span, which is why it's worth the extra care over a bbox query.
//
// The catch: v8 rejects the entire request with a 400 if any single `spans`
// attribute isn't recognised. Rather than guess right once, the request is
// attempted richest-first and falls back a tier at a time, reporting which
// tier succeeded and what HERE said about the ones that didn't.

const ROUTER = "https://router.hereapi.com/v8/routes";

// Richest first. Each tier drops whatever the previous one might have
// choked on, so a rejected attribute costs detail rather than the feature.
const TIERS = [
  { name: "full",
    ret: "summary,polyline,incidents",
    spans: "names,duration,baseDuration,typicalDuration",
    alternatives: 2 },
  { name: "no-typical",
    ret: "summary,polyline,incidents",
    spans: "names,duration,baseDuration",
    alternatives: 2 },
  { name: "names-only",
    ret: "summary,polyline,incidents",
    spans: "names,duration",
    alternatives: 2 },
  { name: "incidents-only",
    ret: "summary,incidents",
    spans: null,
    alternatives: 2 },
  { name: "summary-only",
    ret: "summary",
    spans: null,
    alternatives: 0 },
];

function buildUrl(key, from, to, tier, avoidTolls) {
  const p = new URLSearchParams();
  p.set("origin", from);
  p.set("destination", to);
  p.set("transportMode", "car");
  p.set("return", tier.ret);
  if (tier.spans) p.set("spans", tier.spans);
  if (tier.alternatives) p.set("alternatives", String(tier.alternatives));
  // URLSearchParams encodes the brackets, which HERE accepts and proxies
  // are less likely to mangle than the raw form.
  if (avoidTolls) p.set("avoid[features]", "tollRoad");
  p.set("apiKey", key);
  return `${ROUTER}?${p.toString()}`;
}

async function tryTiers(key, from, to, avoidTolls) {
  const attempts = [];
  for (const tier of TIERS) {
    const url = buildUrl(key, from, to, tier, avoidTolls);
    let res, text;
    try {
      res = await fetch(url);
      text = await res.text();
    } catch (e) {
      attempts.push({ tier: tier.name, error: String(e && e.message || e) });
      continue;
    }
    if (res.ok) {
      try {
        return { data: JSON.parse(text), tier: tier.name, attempts };
      } catch (e) {
        attempts.push({ tier: tier.name, status: res.status, error: "response was not JSON" });
        continue;
      }
    }
    // Keep HERE's own words — its 400s name the offending parameter.
    attempts.push({ tier: tier.name, status: res.status, body: text.slice(0, 300) });
  }
  return { data: null, tier: null, attempts };
}

export async function hereTraffic(key, from, to) {
  const [main, free] = await Promise.all([
    tryTiers(key, from, to, false),
    tryTiers(key, from, to, true),
  ]);

  if (!main.data) {
    const first = main.attempts[0] || {};
    const err = new Error(
      "HERE rejected every request. First attempt returned " +
      (first.status || "no response") + ": " + (first.body || first.error || "no detail"));
    err.attempts = main.attempts;
    throw err;
  }

  const routes = (main.data.routes || []).map(route);
  const tollFree = free.data && free.data.routes && free.data.routes[0]
    ? route(free.data.routes[0]) : null;
  const head = main.data.routes && main.data.routes[0];

  return {
    provider: "here",
    tier: main.tier,                       // which detail level actually worked
    degraded: main.tier !== "full" ? main.tier : null,
    attempts: main.tier === TIERS[0].name ? undefined : main.attempts,
    routes,
    tollFree,
    incidents: incidents(head),
    slow: slow(head),
  };
}

function route(r) {
  let seconds = 0, base = 0, typical = 0, meters = 0, haveTypical = false;
  for (const sec of r.sections || []) {
    const s = sec.summary || {};
    seconds += s.duration || 0;
    base += s.baseDuration || 0;
    meters += s.length || 0;
    for (const sp of sec.spans || []) {
      if (sp.typicalDuration != null) { typical += sp.typicalDuration; haveTypical = true; }
    }
  }
  return {
    seconds,
    freeFlowSeconds: base || null,
    typicalSeconds: haveTypical ? typical : null,
    delaySeconds: base ? Math.max(0, seconds - base) : 0,
    meters,
    jamCount: slow(r).length,
  };
}

const CRIT = { critical: 3, major: 2, minor: 1, lowImpact: 0 };

function incidents(r) {
  if (!r) return [];
  const out = [];
  for (const sec of r.sections || []) {
    for (const i of sec.incidents || []) {
      out.push({
        kind: titleCase(i.type || "incident"),
        criticality: CRIT[i.criticality] ?? 1,
        delaySec: 0,                                  // HERE grades severity, not minutes
        road: "", from: "", to: "",
        description: i.description || titleCase(i.type || "Incident"),
      });
    }
  }
  return out.sort((a, b) => b.criticality - a.criticality).slice(0, 6);
}

// Merge consecutive slow spans on the same road so one jam reads as one line.
function slow(r) {
  if (!r) return [];
  const runs = [];
  for (const sec of r.sections || []) {
    let cur = null;
    for (const sp of sec.spans || []) {
      const dur = sp.duration || 0;
      const base = sp.baseDuration || 0;
      const lost = dur - base;
      const name = (sp.names && sp.names[0] && sp.names[0].value) || "";
      const isSlow = base > 0 && dur / base >= 1.3 && lost >= 15;
      if (isSlow) {
        if (cur && cur.road === name) { cur.delaySec += lost; cur.base += base; }
        else { if (cur) runs.push(cur); cur = { road: name, delaySec: lost, base }; }
      } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
  }
  return runs
    .filter(x => x.delaySec >= 45)
    .map(x => ({
      road: x.road || "unnamed road",
      delaySec: Math.round(x.delaySec),
      jamFactor: Math.min(10, Math.round((x.delaySec / Math.max(x.base, 1)) * 10)),
    }))
    .sort((a, b) => b.delaySec - a.delaySec)
    .slice(0, 5);
}

const titleCase = s =>
  String(s).replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim();

// Raw diagnostic: what was sent, what came back.
export async function hereDiagnose(key, from, to) {
  const out = [];
  for (const tier of TIERS) {
    const url = buildUrl(key, from, to, tier, false);
    const redacted = url.replace(/apiKey=[^&]+/, "apiKey=REDACTED");
    try {
      const r = await fetch(url);
      const t = await r.text();
      out.push({ tier: tier.name, status: r.status, url: redacted, body: t.slice(0, 400) });
      if (r.ok) break;
    } catch (e) {
      out.push({ tier: tier.name, url: redacted, error: String(e && e.message || e) });
    }
  }
  return { attempts: out };
}
