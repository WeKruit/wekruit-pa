# macOS iMessage worker — health check & nginx

## Built-in HTTP health

The worker starts a **JSON** server when **`PA_HEALTH_PORT`** is not `0` (default **`8787`**).

- **URL:** `http://127.0.0.1:<port>/health` (also `/`)
- **Fields:** `ok`, `firebase`, `outboundListener`, `imessageReady`, `uptimeSec`  
- **Bind:** `127.0.0.1` by default. Set **`PA_HEALTH_BIND=0.0.0.0`** to allow LAN access (e.g. nginx on the same Mac proxying to it).
- **Disable:** `PA_HEALTH_PORT=0` in `apps/macos-imessage-worker/.env`.

CORS is enabled on `/health` so a **tunneled** URL (ngrok, Cloudflare Tunnel, Tailscale Funnel) can be pasted into **PA Console** as `VITE_WORKER_HEALTH_URL` for a live “worker ready” badge on **Playground**.

## nginx (local reverse proxy)

Example: expose path `/pa-worker-health` on :8080 → worker:

```nginx
server {
  listen 8080;
  location /pa-worker-health {
    proxy_pass http://127.0.0.1:8787/health;
    proxy_http_version 1.1;
  }
}
```

For **Dashboard** in the browser, the check URL must be **publicly or VPN-reachable**; localhost-only health cannot be fetched from `wekruit-pa.web.app`.

## Same process as “local POC”

`npm run start` in `apps/macos-imessage-worker` is the same class of process you’d run under `launchd`/pm2 on the dedicated Mac; health reflects **this** process only.
