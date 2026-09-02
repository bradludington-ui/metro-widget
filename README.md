# Next Train — Crystal City → Franconia-Springfield

A small desk widget that watches WMATA's real-time Blue Line predictions at Crystal City
(station `C09`) for trains to Franconia-Springfield (`J03`), subtracts your walk time, and
tells you when to stand up.

It sleeps until 2:30 PM on weekdays, then starts calling trains.

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

In `index.html`:

```js
const STATION   = "C09";   // Crystal City
const DEST_CODE = "J03";   // Franconia-Springfield
const LINE      = "BL";
```

Add any new station code to the `ALLOWED` set in `functions/api/trains.js` too, or the proxy
will reject it. Full code list: `https://api.wmata.com/Rail.svc/json/jStations?api_key=YOUR_KEY`
