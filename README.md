# Next Train — Blue Line commute board

A small desk widget that watches WMATA's real-time Blue Line predictions, subtracts your
walk time, and tells you when to move.

It covers both directions of the day and switches between them on its own:

| Leg | Board at | Watching for | Default window |
|---|---|---|---|
| Morning | Franconia-Springfield (`J03`) | Blue Line to Downtown Largo (`G05`) | 6:00 – 9:00 AM |
| Evening | Crystal City (`C09`) | Blue Line to Franconia-Springfield (`J03`) | 2:30 – 7:00 PM |

### Readability

⚙ has a **Text size** control — Small / Normal / Large / Extra large. Everything on the
board scales together: rows, destination, the minutes column, and the countdown.

Two things were making the board harder to read than it needed to be, both now fixed:
the dot-matrix scanline overlay was set at 0.75 opacity in multiply blend, which dimmed
the text it sat on top of; and rows for trains you can no longer catch were drawn in a
very dark amber that was close to invisible against the black board. The overlay is much
lighter now and the dimmed rows are a legible muted amber.

### How far ahead it shows

⚙ has a look-ahead window, default 60 minutes. WMATA's real-time API only predicts trains
it is actively tracking — usually 15–20 minutes out — so on its own it can't fill an
hour. Past that point the board fills in from WMATA's published timetable (`schedule.js`,
served at `/api/schedule`):

- Live predictions come first. Timetable trains are only added after the last live
  train, and never within a couple of minutes of one, so the same train doesn't show twice.
- Timetable rows are tagged **SCH** in the car column and drawn in a softer amber.
- Alerts only follow live trains. A timetable time is fine for planning, but the
  countdown, chime and Go flash wait until WMATA is actually tracking the train.

The METRO strip says what you're looking at: "live to 18 min, then timetable" when the
timetable is filling in, or "WMATA predicting 27 min out" when there's no timetable data
and live coverage stops short of your window.

The timetable needs your own WMATA key, and possibly a GTFS subscription as well (see
[The timetable](#the-timetable)). Until it's available the strip says "own WMATA key needed
for timetable" and the board shows live predictions only. The Worker caches the timetable for 12 hours;
`/api/schedule/debug?station=C09` shows what it parsed.

Outside both windows it sits quiet and tells you when the next one opens. Each leg has its
own walk time and buffer, since the walk from your desk isn't the walk from your car.

The AM / PM buttons in the footer force a leg when you want to check the other direction —
useful for a late start or an early departure. **Auto** hands control back to the clock.

---

## 1. The API key

**You need your own WMATA key.** It's free and takes a few minutes. As of October 2026,
WMATA rejects the old shared demo key (`403`), so without your own key the board shows
"WMATA rejected the shared demo key" and no trains.

1. Sign up at <https://developer.wmata.com/> and confirm your email.
2. Open the menu → **Products** → **Default Tier**, give the subscription any name
   (e.g. "Next Train") and **Subscribe**.
3. Menu → **Profile** → under **Subscriptions**, click **Show** next to **Primary key** and
   copy it. It's a 32-character string. Don't click **Regenerate** unless you mean to
   replace the key — that breaks the board until you update the secret below.
4. Cloudflare dashboard → **Workers & Pages** → **metro-widget** → **Settings** →
   **Variables and Secrets** → **Add**:
   - Type: **Secret**
   - Name: `WMATA_KEY`
   - Value: the key, with no spaces
5. Deploy if prompted, then reopen the app. The dot turns green and the status line reads
   "Live" instead of "Demo key".

Keep the key out of the repo and the page source — it belongs only in that Cloudflare
secret, where the Worker reads it and the browser never sees it.

You don't have to do this on your work machine. Register from a phone or personal computer
and paste the key straight into the Cloudflare dashboard — it never touches the GFE.

If the board says **"WMATA rejected your WMATA_KEY"**, the secret doesn't match your key:
usually a stray space, the secondary key, or a key that was regenerated since. Open
`/api/trains?station=J03` on your site to see WMATA's exact reply.

Free tier limits: 10 calls/second, 50,000 calls/day. This widget polls at most every 20
seconds and only inside its watch windows — a few hundred calls a day. Plenty of headroom.

### The timetable

Filling the board past WMATA's 15–20 minute live horizon needs WMATA's timetable download
(GTFS), which may be a separate product from Default Tier. If the METRO strip still says
"own WMATA key needed for timetable" after you've added your key, look under **Products**
for a GTFS product and subscribe to it with the same account. `/api/schedule/debug?station=J03`
shows WMATA's exact answer. See [How far ahead it shows](#how-far-ahead-it-shows).

### No key set

The Worker still falls back to the old demo key when `WMATA_KEY` is missing, so a fresh
deploy without a key fails with a clear message rather than a crash.

---

## 2. Deploy on Cloudflare Workers

The site runs as a single **Cloudflare Worker**. `worker.js` answers the `/api/…` routes —
calling WMATA (and HERE, for the drive page) with keys it reads from Cloudflare secrets —
and hands every other request to the static files in the repo. Your keys stay on the
server; on a static host like GitHub Pages they'd have to sit in the page's JavaScript,
where anyone who views source could lift them.

`wrangler.jsonc` holds the whole configuration: the Worker's name (`metro-widget`), its
entry point (`worker.js`), and the repo root as the static-asset directory.
`.assetsignore` keeps the Worker source, config and README from being served as files.

### First deploy

1. Push this folder to a GitHub repo (private is fine).
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Workers** →
   **Import a repository**, and pick the repo.
3. Build settings:
   - Build command: *(leave empty — there's nothing to build)*
   - Deploy command: `npx wrangler deploy` (the default)
   - Root directory: `/`
4. Deploy. You'll get a URL like `https://metro-widget.<your-subdomain>.workers.dev`.
5. Add your WMATA key (see section 1): **Settings → Variables and Secrets → Add**, type
   **Secret**, name `WMATA_KEY`. Add `HERE_KEY` the same way if you use the drive page.

Verify the proxy by opening `https://<your-site>/api/trains?station=C09` — you should see
JSON with a `Trains` array. If you see an `error` field instead, it says what WMATA
objected to.

### After that

- **Every push to `main` deploys automatically.** The build shows up as the
  *Workers Builds: metro-widget* check on the commit.
- **Other branches get preview URLs.** Pull requests get a comment from Cloudflare with a
  commit preview and a branch preview link, so you can try a change before merging it.
- **Secrets aren't in the repo**, so they survive every deploy. Saving one in the
  dashboard applies it straight away; no push needed.

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
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app="https://metro-widget.<your-subdomain>.workers.dev" --window-size=400,520 --window-position=1500,520
```

Adjust `--window-position` for your monitor — the numbers above put it near the bottom right
on a 1920×1080 display. Pin that shortcut to the taskbar.

To keep it on top of other windows, Edge/Chrome app windows don't do always-on-top natively.
The free [Microsoft PowerToys](https://github.com/microsoft/PowerToys) "Always on Top"
(`Win + Ctrl + T`) handles it if PowerToys is permitted on your build.

---

## 4. Using it

- It starts on its own. Open the page (or launch the installed app) and it begins watching
  trains — there's no Start button.
- **Tap once to turn sound on.** Browsers won't play sound or ask for notification
  permission until you've interacted with the page. Until you do, a **🔇 Sound** button sits
  in the footer as a reminder; the first tap or keypress anywhere enables the chime, asks
  for notification permission and hides the button. The red screen flash works without it.
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

- **The proxy may block `*.workers.dev` or `api.wmata.com`.** Test the `/api/trains` URL in a
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
| `worker.js` | Worker entry point: WMATA proxy and traffic endpoints |
| `traffic.js` | HERE routing and incidents |
| `schedule.js` | WMATA's published timetable (`/api/schedule`), which fills the board past the live prediction horizon |
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

## Traffic — the drive to the Pentagon

`drive.html` is a separate page for the Lorton → Pentagon commute. It shares the same
Worker but stands alone, so it can be installed on a different phone without carrying the
train widget along.

### This one needs a key

WMATA publishes open data because it is a public agency. Live traffic is
commercially owned, so this part needs a key.

1. Sign up at <https://developer.here.com/>
2. Create a project, generate a **REST API key**.
3. Cloudflare → your Worker → Settings → Variables and Secrets → add secret `HERE_KEY`.

Until that's set the page says so plainly rather than showing a blank screen. At a
3-minute auto-refresh over a one-hour window that's about 20 calls a morning.

### Why the request is tiered

HERE Routing v8 rejects the **entire** request with a 400 if any single `spans` attribute
isn't recognised, so one wrong attribute name costs you the whole feature. The request is
therefore attempted richest-first and steps down a tier at a time:

| Tier | Requests | Costs you |
|---|---|---|
| `full` | names, duration, baseDuration, typicalDuration | — |
| `no-typical` | drops typicalDuration | historic baseline |
| `names-only` | drops baseDuration | named slow stretches |
| `incidents-only` | no spans | slow stretches entirely |
| `summary-only` | no incidents | everything but the travel time |

The header shows the tier in brackets when it isn't `full`, so degraded data is never
mistaken for complete data.

### When it fails

The page prints HERE's own error text and every tier attempted, because HERE's 400s name
the offending parameter. For the raw exchange — URLs sent with the key redacted, statuses,
and full response bodies:

```
/api/traffic/debug
```

### What it shows

- **Door to door minutes**, compared against *typical* conditions for that time of day
  rather than free-flow. Free-flow is a 3 a.m. number and would call every commute a
  disaster.
- **Where it's slow**, by road name with a severity bar. Consecutive slow stretches on the
  same road are merged, so one jam reads as one line.
- **Route options**: the fastest route now, the best toll-free route, and an alternate.
  Around here the fastest usually means the 95 Express Lanes, so the toll-free row is
  effectively "what the toll is buying you this morning" — the actual decision at Exit 163.
  With HOV-3+ and an E-ZPass Flex the Express Lanes are free, which makes that comparison
  a time saving rather than a purchase.
- **Incidents on her route** — taken from the route's own incident spans, so a crash on a
  parallel road never appears.
- **Leave-by time**, if an arrive-by time is set in ⚙.

### Setting the start point

The default is the I-95 / Lorton Road interchange at Exit 163, which is a landmark rather
than a driveway. For a real door-to-door number, put her actual start point in ⚙: in
Google Maps, right-click the spot and click the coordinates to copy them, then paste.

### Install it on her phone

Same as the train widget — open the page, then Add to Home Screen (iOS) or Install app
(Android). It keeps its own settings, so her start point and arrive-by time don't affect
your widget.
