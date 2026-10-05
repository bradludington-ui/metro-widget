# Next Train — Blue Line commute board

A small desk widget that watches WMATA's real-time Blue Line predictions, subtracts your
walk time, and tells you when to move.

It covers both directions of the day, picked by the clock:

| Button | Board at | Watching for | Shown by default |
|---|---|---|---|
| **AM** | Franconia-Springfield (`J03`) | Blue Line to Downtown Largo (`G05`) | midnight – 11:59 AM |
| **PM** | Crystal City (`C09`) | Blue Line to Franconia-Springfield (`J03`) | noon – 11:59 PM |

Tap **AM** or **PM** in the footer to check the other direction — useful for a late start
or an early departure. Your pick holds until the next noon or midnight, then the board goes
back to following the clock, so a board left open all day still flips to PM at noon.

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
[The timetable](#the-timetable)). Until it's available the strip says why
("no WMATA key set" or "timetable refused — GTFS subscription?") and the board shows live
predictions only.

The full timetable is a large download, so the Worker builds a small index for your two
stations and keeps it for 12 hours — in memory, and in a Workers KV namespace so it
survives restarts (see [Timetable storage](#timetable-storage)). The download happens
about twice a day. `/api/schedule/debug?station=C09` shows what it parsed and where it came
from (`"source": "memory"`, `"kv"` or `"wmata"`).

Each direction has its own walk time and buffer in ⚙, since the walk from your door isn't
the walk from your desk.

---

## 1. The API key

**You need your own WMATA key.** It's free and takes a few minutes. WMATA's old
shared demo key stopped working in October 2026, so without your own key the board shows
"No WMATA key set" and no trains.

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
   "Live".

Keep the key out of the repo and the page source — it belongs only in that Cloudflare
secret, where the Worker reads it and the browser never sees it.

You don't have to do this on your work machine. Register from a phone or personal computer
and paste the key straight into the Cloudflare dashboard — it never touches the GFE.

If the board says **"WMATA rejected your WMATA_KEY"**, the secret doesn't match your key:
usually a stray space, the secondary key, or a key that was regenerated since. Open
`/api/trains?station=J03` on your site to see WMATA's exact reply.

Free tier limits: 10 calls/second, 50,000 calls/day. This widget polls at most every 20
seconds, and only while it's open — even left open around the clock that's under 5,000
calls a day. Plenty of headroom.

### The timetable

Filling the board past WMATA's 15–20 minute live horizon needs WMATA's timetable download
(GTFS), which may be a separate product from Default Tier. If the METRO strip says
"timetable refused — GTFS subscription?" after you've added your key, look under
**Products** for a GTFS product and subscribe to it with the same account. (With the key
from October 2026, Default Tier covered it.) `/api/schedule/debug?station=J03`
shows WMATA's exact answer. See [How far ahead it shows](#how-far-ahead-it-shows).

### No key set

Without a `WMATA_KEY` secret the Worker doesn't call WMATA at all: the board says
"No WMATA key set" with where to add it, and the METRO strip says the same.

---

## 2. Deploy on Cloudflare Workers

The site runs as a single **Cloudflare Worker**. `worker.js` answers the `/api/…` routes —
calling WMATA with the key it reads from a Cloudflare secret —
and hands every other request to the static files in the repo. Your key stays on the
server; on a static host like GitHub Pages it would have to sit in the page's JavaScript,
where anyone who views source could lift it.

`wrangler.jsonc` holds the whole configuration: the Worker's name (`metro-widget`), its
entry point (`worker.js`), the repo root as the static-asset directory, and the KV
namespace the timetable is stored in.
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
   **Secret**, name `WMATA_KEY`.

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

### Timetable storage

`wrangler.jsonc` binds a KV namespace as `TIMETABLE`
(`metro-widget-timetable`, created in this account in October 2026). It holds the built
timetable for each station, keyed on a short hash of your API key — never the key itself —
and each entry expires after 12 hours. The free plan's KV limits are far above what this
uses (a handful of writes a day).

Deploying to a different Cloudflare account? Create a namespace there (**Storage &
Databases → KV → Create**) and put its ID in `wrangler.jsonc`. Or delete the
`kv_namespaces` block: the Worker then keeps the timetable in memory only and downloads it
more often, but works the same.

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
- It tracks trains whenever it's open — mornings show **AM**, afternoons and evenings show
  **PM**. Close it when you don't need it.
- **On a phone, keep the board on screen when you're relying on it.** Once the screen
  turns off, phone browsers suspend web pages, so the chime and notification can't fire
  until you open it again. "Keep screen awake" in ⚙ holds the screen on while the board is
  open. On a desktop the alerts still fire when the window is covered by others.
- The countdown only ever targets a train you can still make. If the next train leaves
  before you could reach the platform, it's shown dimmed and the board says "Nothing
  catchable" rather than telling you to run for it.
- `Esc` dismisses an active alert.

### Call volume

The refresh setting in ⚙ is the *fastest* rate, used only when your countdown is under
five minutes. Further out it polls at half and then a third of that — about one call a
minute while your train is still a way off.

When the board can't be seen — minimized, in a background tab, or the phone locked — it
stops calling WMATA altogether, unless you need to leave within 15 minutes; then it keeps
polling so the heads-up and Go alerts still fire on fresh data. (Windows can count a window
that's merely covered by others as hidden, which is why the alerts don't simply stop.)
Bringing it back into view refreshes immediately.

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
| `worker.js` | Worker entry point: WMATA proxy (`/api/trains`, `/api/schedule`) |
| `tests/` | Automated tests (`node --test`) |
| `schedule.js` | WMATA's published timetable (`/api/schedule`), which fills the board past the live prediction horizon |
| `manifest.webmanifest` | Makes it installable as a taskbar app |
| `sw.js` | Service worker; required for installability, never caches train data |
| `icon-192.png`, `icon-512.png` | App icons |

## Tests

```
node --test
```

Runs everything in `tests/` with Node's built-in test runner (Node 22 or newer, nothing
to install). They exercise the Worker and the timetable code against a fake WMATA and a
small WMATA-shaped GTFS file built on the fly: every route answers with and without a key,
WMATA failures are explained, the board's "Downtown Largo" and "BL" match the feed's
"Largo" and "B", the timetable is fetched past Cloudflare's shared cache and stored per key.

GitHub runs the same command on every pull request and push to `main`
(`.github/workflows/test.yml`), alongside Cloudflare's build check. The board's own page
logic (AM/PM switching, alerts) isn't covered — that needs a browser.

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
