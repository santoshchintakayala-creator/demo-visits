# Demo Visits

See who opens the website demos you send to prospects: which person (via tracked links), from which city, on what device, which pages they looked at, for how long, and what they clicked.

One tracker serves every demo. Each demo site sends small "beacons" here, and the dashboard groups them by demo.

## What gets recorded

| Event | When |
|---|---|
| `view` | A page opens |
| `leave` | The visitor leaves or hides the page (with visible time on that page) |
| `click` | A link or button is clicked (its label and destination only) |
| `form` | A form is submitted (its name only, never what was typed) |
| `intro` | The demo welcome popup is shown, OK'd or closed |

Location comes from Vercel's own edge headers (`x-vercel-ip-city`, region, country), so no outside lookup service is used. Raw IP addresses are never stored: each network becomes a salted, one-way 12-character id so repeat visits from the same place can be grouped. Search engines, link-preview fetchers (iMessage, Slack, WhatsApp, Facebook) and headless browsers are ignored.

## Set up on Vercel (about 5 minutes)

1. **Import the repo.** vercel.com → Add New → Project → import `demo-visits`. No framework, no build settings to change.
2. **Add a database.** In the new project: Storage → Connect Database → **Upstash for Redis** (the free plan is plenty). Connect it to this project for Production and Preview. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Set a password.** Settings → Environment Variables → `ADMIN_PASSWORD` = a password only you know.
4. **Optional:** `IP_SALT` (any long random text) and `ALLOWED_ORIGINS` (comma-separated demo addresses, e.g. `https://pace-plumbing-houston.vercel.app`) so only your demos can send visits.
5. **Redeploy** (Deployments → ⋯ → Redeploy) and open the project's address. Sign in with your password.

Your collect address is `https://<this-project>.vercel.app/api/collect`.

## Connect a demo site

Add the beacon script to every page of the demo:

```html
<script src="/demo-track.js" defer
        data-endpoint="https://<this-project>.vercel.app/api/collect"
        data-site="pace-plumbing-houston"></script>
```

`demo-track.js` lives in the demo's repo (see `pace-plumbing-houston/public/demo-track.js` for the reference copy). In `pace-plumbing-houston` it is switched on by setting `DEMO_TRACK_ENDPOINT` in that project's Vercel environment variables, or in `src/demo-config.mjs`.

## Using it

- **Tracked links.** In the dashboard, create one link per person ("Jonathan Pace, texted Oct 21"). Each link is the demo address plus `?r=<code>`. Visits from that link show up with the person's name, and the browser keeps the code for later visits even without it. Other browsers on the same network are shown as "Possibly Jonathan Pace".
- **Don't count yourself.** Open each demo once with `?notrack=1` on your own phones and computers; that browser is then ignored. `?notrack=0` turns it back on.
- **Live.** A green dot means the visitor was active in the last 5 minutes. The dashboard refreshes every 30 seconds.
- **Retention.** The newest 50,000 events per demo are kept. "Delete all visits for this demo" at the bottom clears one demo.

## Run locally

```
npm run dev     # http://localhost:4300, password "dev", in-memory storage
npm test
```

## Files

- `api/collect.js`: receives beacons, adds location and device, stores them
- `api/data.js`: dashboard data (sign-in required)
- `api/links.js`: create and delete tracked links (sign-in required)
- `api/login.js`: sign in and out (signed, HttpOnly cookie; 10 attempts per 10 minutes)
- `lib/store.mjs`: Upstash Redis over REST, with an in-memory fallback for local use
- `lib/http.mjs`: request helpers, location, device detection, auth
- `public/`: the dashboard (plain HTML, CSS and JavaScript)
