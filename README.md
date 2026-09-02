# Next Train — Blue Line commute board

A small desk widget that watches WMATA's real-time Blue Line predictions, subtracts your
walk time, and tells you when to move.

It covers both directions of the day and switches between them on its own:

| Leg | Metro board | VRE board | Default window |
|---|---|---|---|
| Morning | Franconia-Springfield → Downtown Largo | Franconia-Springfield → Crystal City | 6:00 – 9:00 AM |
| Evening | Crystal City → Franconia-Springfield | Crystal City → Franconia-Springfield | 2:30 – 7:00 PM |

The board is split: Metro on top, VRE underneath with live delay status. The big countdown
tracks whichever service you'd have to leave for first; ⚙ can pin it to Metro or VRE only.

Outside both windows it sits quiet and tells you when the next one opens. Each leg has its
own walk time and buffer, since the walk from your desk isn't the walk from your car.

The AM / PM buttons in the footer force a leg when you want to check the other direction —
useful for a late start or an early departure. **Auto** hands control back to the clock.

---

## 1. The API key

**No account needed.** The proxy falls back to WMATA's published demo key
(`e13626d03d8e4c03ac07f95541b3091b`) when no secret is set. Deploy and you have live
trains. The status line reads "Demo key" so you always know which one you're on.

Know what you're running on, though:

- It's shared by every developer poking at the API, so the quota is whatever's left after
  everyone else. Busy afternoons are exactly when it's most contended.
- WMATA's terms of use scope it to testing, not production applications.
- It can be rotated without notice. When that happens the widget won't crash, but it will
  stop knowing where your trains are.

The widget is built to survive all three: it polls slowly when your train is far off,
backs off exponentially on errors, and keeps counting down from the last known arrival
times rather than going blank. But a rotated key at 4:15 PM still means no board.

If you get your own key later it takes two minutes and none of this applies:

1. Sign up at <https://developer.wmata.com/>
2. Subscribe to the **Default Tier** product.
3. Copy your primary key. It's a 32-character string.

You don't have to do this on your work machine. Register from a personal computer and
paste the key straight into the Cloudflare dashboard — it never touches the GFE.

Free tier limits: 10 calls/second, 50,000 calls/day. This widget polls once every 20 seconds
during your afternoon window — roughly 500 calls/day. Plenty of headroom.

---

## 2. Deploy on Cloudflare Pages (recommended)

Cloudflare is the better host here because a **Pages Function** keeps your API key on the
server. On GitHub Pages the key would have to sit in the client-side JavaScript, where anyone
who views source can lift it.

1. Push this folder to a GitHub repo (private is fine).
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
4. Once you have your own key: **Settings → Variables and Secrets → Add**
   - Type: **Secret**
   - Name: `WMATA_KEY`
   - Value: your key
5. Redeploy. You'll get a URL like `https://next-train.pages.dev`.

Verify the proxy works by opening `https://your-site.pages.dev/api/trains?station=C09` —
you should see JSON with a `Trains` array.

### If you'd rather use GitHub Pages

The `functions/` directory won't run there. You'd need to either put the key directly in
`index.html` (change `const API` to the WMATA URL with `?api_key=...`) or deploy the function
separately as a Cloudflare Worker and point `API` at it. Option two is worth the extra step.

---

## 3. Put it on your taskbar

**Microsoft Edge** (usually the path of least resistance on a government machine):

1. Open the site.
2. `⋯` menu → **Apps** → **Install this site as an app**.
3. Name it "Next Train". It opens in its own frameless window with no browser chrome.
4. Right-click the taskbar icon → **Pin to taskbar**.
5. Edge → `edge://apps` → your app → enable **Start app when I sign in** if you want it
   to launch itself every morning.

Chrome is the same idea: `⋮` → **Cast, save, and share** → **Install page as app**.

**If app installation is blocked by policy**, fall back to a desktop shortcut:

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="https://your-site.pages.dev" --window-size=400,520 --window-position=1500,520
```

Adjust `--window-position` for your monitor — the numbers above put it near the bottom right
on a 1920×1080 display. Pin that shortcut to the taskbar.

To keep it on top of other windows, Edge/Chrome app windows don't do always-on-top natively.
The free [Microsoft PowerToys](https://github.com/microsoft/PowerToys) "Always on Top"
(`Win + Ctrl + T`) handles it if PowerToys is permitted on your build.

---

## 4. Using it

- **Start** arms the widget for the day. Do this once each morning. The click also unlocks
  audio — browsers won't play sound without a user gesture, so this button is doing real work.
- Nothing appears on the board until **2:30 PM**, Monday–Friday. Both are adjustable in ⚙.
- **Demo** fakes a train feed so you can watch the whole alert sequence without waiting until
  the afternoon. Turn it off before you rely on it.
- **Test alert** fires the chime and notification once.
- `Esc` dismisses an active alert.

### Call volume

The refresh setting in ⚙ is the *fastest* rate, used only when your countdown is under
five minutes. Further out it polls at half and then a third of that. With the defaults
and a 2:30–6:00 PM window that's roughly 200 calls a day rather than 630.

On errors it backs off — 2x, 4x, 8x the base interval, capped at five minutes — and the
status line tells you whether it's a rate limit or a dead connection.

### How the countdown works

```
countdown = train arrival − walk time − safety buffer
```

Defaults are an 8-minute walk and a 2-minute buffer, so a train 12 minutes out gives you a
2:00 countdown. Change both in ⚙ once you've timed the walk from your desk.

Three states:

| State | Trigger | What happens |
|---|---|---|
| Tracking | normal | Amber countdown, quiet |
| Two minutes | countdown ≤ 2:00 | Board warms, single soft chime, notification |
| Go | countdown hits 0:00 | Whole widget flips red and pulses, three-tone chime, Windows notification |

The widget locks onto one train rather than always showing the soonest, so the countdown
doesn't jump around when WMATA revises its estimates. It rolls to the next train about a
minute after your locked train arrives.

---

## Things that may bite you on a government machine

- **The proxy may block `*.pages.dev` or `api.wmata.com`.** Test the `/api/trains` URL in a
  browser tab before building any habits around this.
- **Notifications need permission** and can be disabled by Group Policy. If the toast never
  appears, the in-window red flash still works — it's the primary signal, not the backup.
- **Audio** may be muted at the OS level or blocked in the browser's site settings.
- **Check your IT policy before deploying.** Standing up a personal web app and calling an
  external API from a GFE workstation is the kind of thing that's usually fine and
  occasionally very much not. Worth a quick read of your AUP or a note to your ISSO.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire widget — UI, alert logic, audio, no dependencies |
| `functions/api/trains.js` | Cloudflare Pages Function; holds the API key, proxies WMATA |
| `manifest.webmanifest` | Makes it installable as a taskbar app |
| `sw.js` | Service worker; required for installability, never caches train data |
| `icon-192.png`, `icon-512.png` | App icons |

## Changing stations

Both legs are defined at the top of the script in `index.html`:

```js
const LEGS = {
  am: { from:"J03", fromName:"Franconia-Spfld", toCode:"G05", toName:"Downtown Largo", ... },
  pm: { from:"C09", fromName:"Crystal City",    toCode:"J03", toName:"Franconia-Spfld", ... }
};
```

`from` is the station whose board you're reading; `toCode` is the destination you're
filtering for, which is what establishes direction.

Add any new `from` code to the `ALLOWED` set in `worker.js` as well, or the proxy will
reject it. Destination codes don't need to be listed — only origins are queried.

Full code list: `https://api.wmata.com/Rail.svc/json/jStations?api_key=YOUR_KEY`


---

## VRE

VRE publishes its data openly — no account, no key, no portal:

| Feed | URL |
|---|---|
| Static schedule | `https://gtfs.vre.org/containercdngtfsupload/google_transit.zip` |
| Realtime trip updates | `https://gtfs.vre.org/containercdngtfsupload/TripUpdateFeed` |

Neither is browser-readable. The schedule is a zip of CSVs (GTFS); the realtime feed is
Protocol Buffers (GTFS-Realtime). `vre.js` contains a small ZIP reader, a CSV parser and a
minimal protobuf decoder to handle both — no npm dependencies, all built-ins.

How a departure gets built:

1. The zip gives the timetable. `shapes.txt` is skipped — it's by far the largest file and
   nothing here needs route geometry.
2. Trips are filtered by line (`vreLine` in the `LEGS` block, default `Fredericksburg`) and
   to those serving both your stations **with the origin earlier in the sequence**, which is
   what establishes direction.
   Station matching prefers an exact name match and ignores unnamed stops — entrances,
   boarding areas and parent-station records. Without that, a blank stop name matches every
   query and pulls in trips from the wrong line.
3. `calendar.txt` and `calendar_dates.txt` decide which trips run today, including holiday
   and S-schedule exceptions.
4. The realtime feed supplies a delay or an absolute predicted time, matched by trip **and
   service date** so today's delay is never applied to tomorrow's train.

If the realtime feed is unreachable the schedule still displays, marked `scheduled` rather
than showing a false on-time.

### Fallback behaviour

An empty board tells you nothing about why it's empty, so when the filters find no trains
the lookup relaxes them one at a time and labels the result:

| Mode | Meaning |
|---|---|
| `filtered` | Line and direction both applied — normal |
| `either-way` | Direction filter found nothing, so both directions are shown |
| `any-line` | Line filter found nothing, so all lines are shown |
| `all-departures` | Destination couldn't be matched; every departure from the origin |

The VRE strip shows the fallback in the corner when one is in effect, so a degraded board
is never mistaken for a normal one.

### If VRE station names don't match

Matching is on station name, not ID, since the widget is configured with names. To see
exactly how VRE spells things:

```
https://your-worker-url/api/vre/stations
```

That lists every station and route in the current feed. Adjust `vreFrom`, `vreTo` and
`vreLine` in the `LEGS` block in `index.html` if a name doesn't line up.

If the board says there are no trains, this reports every filtering stage so you can see
which one dropped them:

```
/api/vre/debug?from=Crystal%20City&to=Franconia-Springfield&route=Fredericksburg
```

The `stages` object counts trips surviving each step — `onRoute`, `runningToday`,
`servesOrigin`, `servesBoth`, `rightDirection`, `stillToCome`. Whichever count falls to zero
is the filter at fault. Omit `&route=` to test without the line filter.

To check what a leg resolves to, including which stop IDs matched:

```
/api/vre?from=Crystal%20City&to=Franconia-Springfield&route=Fredericksburg
```

Drop `&route=` to see every line serving the pair.

### Worker CPU

The schedule is parsed on demand and held in memory for six hours, and the zip itself is
edge-cached, so the parse happens rarely. If you ever see CPU-limit errors on the free plan,
the fix is to move the parse into a scheduled job that stores parsed JSON in KV — but the
in-memory cache should keep you well clear.

---

## Traffic — the drive to the Pentagon

`drive.html` is a separate page for the Lorton → Pentagon commute. It shares the same
Worker but stands alone, so it can be installed on a different phone without carrying the
train widget along.

### This one needs a key — either of two

Metro and VRE publish open data because they're public agencies. Live traffic is
commercially owned, and there is no free keyless equivalent. Two providers are supported;
set `HERE_KEY` or `TOMTOM_KEY` as a secret on the Worker and it uses whichever is present,
preferring HERE.

| | HERE | TomTom |
|---|---|---|
| Incidents | **On the route itself** (`spans=incidents`) | Bounding box around the corridor — may include roads she isn't on |
| Where it's slow | **Named roads** with per-span jam factor | Point indices only, no names |
| Baseline | Free-flow (`baseDuration`) | Free-flow **and historic typical** |
| Signup | Card may be requested | **No credit card**, 2,500 requests/day |

HERE is the better data for this job; TomTom is the easier signup and is the only one that
gives a historic baseline. Setting both and switching with `?provider=here` or
`?provider=tomtom` is a reasonable way to decide.

- HERE: <https://developer.here.com/> → create a project → generate an API key
- TomTom: <https://developer.tomtom.com/> → create an app → copy the key

Until one is set, the page says so plainly rather than showing a blank screen. At a
3-minute auto-refresh over a one-hour window that's about 20 calls a morning; neither
allowance is a constraint.

### About the verdict line

The headline judgement adapts to what the provider actually measures. With TomTom's
historic baseline it compares against *typical conditions for that time of day* — so an
ordinary rush hour reads "About normal for this time" and stays quiet. With HERE, only a
free-flow baseline exists, so it says "Busy — 19 min over an empty road" instead: honest
about the yardstick rather than implying every commute is unusually bad.

### What it shows

- **Door to door minutes**, compared against *typical* conditions for that time of day
  rather than free-flow. Free-flow is a 3 a.m. number and would call every commute a
  disaster.
- **Where it's slow**, by road name with a severity bar, when using HERE.
- **Route options**: the fastest route now, the best toll-free route, and an alternate.
  Around here the fastest usually means the 95 Express Lanes, so the toll-free row is
  effectively "what the toll is buying you this morning" — the actual decision at Exit 163.
  With HOV-3+ and an E-ZPass Flex the Express Lanes are free, which makes that comparison
  a time saving rather than a purchase.
- **Incidents**, headed either "on her route" (HERE) or "nearby" (TomTom), so a crash on a
  parallel road is never mistaken for one on her path.
- **Leave-by time**, if an arrive-by time is set in ⚙.

### Setting the start point

The default is the I-95 / Lorton Road interchange at Exit 163, which is a landmark rather
than a driveway. For a real door-to-door number, put her actual start point in ⚙: in
Google Maps, right-click the spot and click the coordinates to copy them, then paste.

### Install it on her phone

Same as the train widget — open the page, then Add to Home Screen (iOS) or Install app
(Android). It keeps its own settings, so her start point and arrive-by time don't affect
your widget.
