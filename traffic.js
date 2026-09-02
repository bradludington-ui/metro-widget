// Traffic providers.
//
// Two adapters behind one shape, so drive.html doesn't know or care which is
// in use. HERE is preferred when its key is present: it can attach incidents
// to the route itself and name the roads where traffic is slow. TomTom is a
// solid fallback and has the easier signup.
//
// Both return:
//   { provider, routes:[Route], tollFree:Route|null, incidents:[Incident], slow:[Slow] }
//   Route    { seconds, freeFlowSeconds, typicalSeconds, delaySeconds, meters, jamCount }
//   Incident { kind, criticality, delaySec, road, from, to, description }
//   Slow     { road, jamFactor, delaySec, fromName, toName }

/* ================================================================== *
 * HERE
 * ================================================================== */

const HERE_ROUTER = "https://router.hereapi.com/v8/routes";

export async function hereTraffic(key, from, to) {
  const common =
    "&transportMode=car" +
    "&return=summary,polyline,incidents" +
    "&spans=names,duration,baseDuration,dynamicSpeedInfo";

  const q = (extra = "") =>
    `${HERE_ROUTER}?origin=${from}&destination=${to}${common}${extra}&apiKey=${key}`;

  const [mainRes, freeRes] = await Promise.all([
    fetch(q("&alternatives=2")),
    fetch(q("&avoid[features]=tollRoad")),
  ]);
  if (!mainRes.ok) {
    throw new Error("HERE routing " + mainRes.status + " " + (await mainRes.text()).slice(0, 160));
  }
  const main = await mainRes.json();
  const free = freeRes.ok ? await freeRes.json() : null;

  const routes = (main.routes || []).map(hereRoute);
  const tollFree = free && free.routes && free.routes[0] ? hereRoute(free.routes[0]) : null;

  return {
    provider: "here",
    routes,
    tollFree,
    // Incidents come back attached to the route sections, so these are
    // on her actual path rather than merely nearby.
    incidents: hereIncidents(main.routes && main.routes[0]),
    slow: hereSlow(main.routes && main.routes[0]),
  };
}

function hereRoute(r) {
  let seconds = 0, base = 0, meters = 0;
  for (const sec of r.sections || []) {
    const s = sec.summary || {};
    seconds += s.duration || 0;
    base += s.baseDuration || 0;
    meters += s.length || 0;
  }
  return {
    seconds,
    freeFlowSeconds: base,
    typicalSeconds: null,          // HERE gives live vs free-flow, not historic
    delaySeconds: Math.max(0, seconds - base),
    meters,
    jamCount: hereSlow(r).length,
  };
}

const HERE_CRIT = { critical: 3, major: 2, minor: 1, lowImpact: 0 };

function hereIncidents(route) {
  if (!route) return [];
  const out = [];
  for (const sec of route.sections || []) {
    for (const i of sec.incidents || []) {
      out.push({
        kind: titleCase(i.type || "incident"),
        criticality: HERE_CRIT[i.criticality] ?? 1,
        delaySec: 0,                                  // HERE reports severity, not minutes
        road: "",
        from: "", to: "",
        description: i.description || titleCase(i.type || "Incident"),
      });
    }
  }
  return out
    .sort((a, b) => b.criticality - a.criticality)
    .slice(0, 6);
}

// Walk the route spans and pull out the stretches actually running slow,
// merging consecutive spans on the same road so one jam reads as one entry.
function hereSlow(route) {
  if (!route) return [];
  const runs = [];
  for (const sec of route.sections || []) {
    let cur = null;
    for (const sp of sec.spans || []) {
      const dur = sp.duration || 0, base = sp.baseDuration || 0;
      const lost = dur - base;
      const ratio = base > 0 ? dur / base : 1;
      const name = (sp.names && sp.names[0] && sp.names[0].value) || "";
      const slow = base > 0 && ratio >= 1.3 && lost >= 15;

      if (slow) {
        if (cur && cur.road === name) { cur.delaySec += lost; cur.base += base; }
        else { if (cur) runs.push(cur); cur = { road: name, delaySec: lost, base }; }
      } else if (cur) { runs.push(cur); cur = null; }
    }
    if (cur) runs.push(cur);
  }
  return runs
    .filter(r => r.delaySec >= 45)
    .map(r => ({
      road: r.road || "unnamed road",
      delaySec: Math.round(r.delaySec),
      // Approximate HERE's 0-10 jam factor from how much slower than baseline
      jamFactor: Math.min(10, Math.round((r.delaySec / Math.max(r.base, 1)) * 10)),
    }))
    .sort((a, b) => b.delaySec - a.delaySec)
    .slice(0, 5);
}

const titleCase = s => String(s).replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim();

/* ================================================================== *
 * TomTom
 * ================================================================== */

const TT_ROUTER = "https://api.tomtom.com/routing/1/calculateRoute";
const TT_ICON = { 0:"Unknown", 1:"Accident", 2:"Fog", 3:"Dangerous conditions", 4:"Rain",
  5:"Ice", 6:"Jam", 7:"Lane closed", 8:"Road closed", 9:"Road works", 10:"Wind",
  11:"Flooding", 14:"Broken down vehicle" };

export async function tomtomTraffic(key, from, to) {
  const base = `${TT_ROUTER}/${encodeURIComponent(from)}:${encodeURIComponent(to)}/json`;
  const common = "&traffic=true&travelMode=car&routeType=fastest&computeTravelTimeFor=all" +
                 "&sectionType=traffic&instructionsType=text";

  const [fastRes, freeRes] = await Promise.all([
    fetch(`${base}?key=${key}${common}&maxAlternatives=2`),
    fetch(`${base}?key=${key}${common}&avoid=tollRoads`),
  ]);
  if (!fastRes.ok) {
    throw new Error("TomTom routing " + fastRes.status + " " + (await fastRes.text()).slice(0, 160));
  }
  const fast = await fastRes.json();
  const free = freeRes.ok ? await freeRes.json() : null;

  // TomTom's incidents come from a bounding box, so they may include roads
  // that aren't on the route. Flagged in the response so the UI can say so.
  const [aLat, aLon] = from.split(",").map(Number);
  const [bLat, bLon] = to.split(",").map(Number);
  const pad = 0.06;
  const bbox = [Math.min(aLon,bLon)-pad, Math.min(aLat,bLat)-pad,
                Math.max(aLon,bLon)+pad, Math.max(aLat,bLat)+pad].join(",");
  const fields = "{incidents{type,properties{iconCategory,magnitudeOfDelay,events{description,code}," +
                 "startTime,endTime,from,to,length,delay,roadNumbers}}}";

  let incidents = [];
  try {
    const incRes = await fetch("https://api.tomtom.com/traffic/services/5/incidentDetails" +
      `?key=${key}&bbox=${bbox}&fields=${encodeURIComponent(fields)}` +
      "&language=en-GB&timeValidityFilter=present");
    if (incRes.ok) {
      const inc = await incRes.json();
      incidents = (inc.incidents || []).map(i => {
        const p = i.properties || {};
        return {
          kind: TT_ICON[p.iconCategory] || "Incident",
          criticality: Math.min(3, p.magnitudeOfDelay || 0),
          delaySec: p.delay || 0,
          road: (p.roadNumbers || []).join("/"),
          from: p.from || "", to: p.to || "",
          description: (p.events || []).map(e => e.description).filter(Boolean).join("; "),
        };
      })
      .filter(i => i.delaySec > 60 || i.criticality >= 3 || i.kind === "Accident")
      .sort((a, b) => b.delaySec - a.delaySec)
      .slice(0, 6);
    }
  } catch (e) { /* routing without incidents is still useful */ }

  return {
    provider: "tomtom",
    nearbyOnly: true,          // incidents are corridor-box, not route-exact
    routes: (fast.routes || []).map(ttRoute),
    tollFree: free && free.routes && free.routes[0] ? ttRoute(free.routes[0]) : null,
    incidents,
    slow: [],                  // TomTom sections give indices, not road names
  };
}

function ttRoute(r) {
  const s = r.summary || {};
  const jams = (r.sections || [])
    .filter(x => x.sectionType === "TRAFFIC")
    .filter(x => (x.delayInSeconds || 0) > 30);
  return {
    seconds: s.travelTimeInSeconds,
    freeFlowSeconds: s.noTrafficTravelTimeInSeconds,
    typicalSeconds: s.historicTrafficTravelTimeInSeconds,
    delaySeconds: s.trafficDelayInSeconds || 0,
    meters: s.lengthInMeters,
    jamCount: jams.length,
  };
}
