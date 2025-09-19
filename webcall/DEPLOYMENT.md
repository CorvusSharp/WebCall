# DEPLOYMENT GUIDE

## 1. Overview
Two primary deployment modes:
1. Docker Compose (recommended: fastest, reproducible, includes Prometheus & Grafana)
2. Bare Metal (systemd + nginx + separate Postgres/Redis)

## 2. Environment Variables
Required:
- `APP_ENV=prod`
- `JWT_SECRET=<random-long-secret>`
- `REGISTRATION_SECRET=<secret-for-initial-user-registration>`
- `DATABASE_URL=postgresql+asyncpg://webcall:<password>@postgres:5432/webcall` (or external DB)
- `REDIS_URL=redis://redis:6379/0`

Recommended:
- `RATE_LIMIT=100/60` (example global per user+path)
- `CALL_INVITES_BACKEND=redis`
- `CORS_ORIGINS=https://your.domain,https://admin.domain`
- TURN (if using self-hosted TURN):
  - `TURN_URLS=turn:turn.your.domain:3478?transport=udp,turn:turn.your.domain:3478?transport=tcp`
  - `TURN_USERNAME=...`
  - `TURN_PASSWORD=...`
  - `TURN_PUBLIC_IP=<public_ip>`
  - `TURN_REALM=your.domain`
- Web Push (optional):
  - `VAPID_PUBLIC_KEY=...`
  - `VAPID_PRIVATE_KEY=...`
  - `VAPID_SUBJECT=mailto:admin@your.domain`
- Observability:
  - `GRAFANA_ADMIN_PASSWORD=StrongPass123!`

## 3. Docker Compose Deployment
Clone repository on server (Ubuntu example):
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER
# relogin
git clone https://your.git/WebCall.git webcall && cd webcall/webcall
cp .env.example .env
# edit .env and set secrets (JWT_SECRET, REGISTRATION_SECRET, DB passwords, etc.)
```
Adjust `docker-compose.yml` if using external Postgres/Redis (remove internal services, set URLs).

Build & start:
```bash
docker compose pull
# production image build (optional alternative build)
DOCKER_BUILDKIT=1 docker build -f docker/api.prod.Dockerfile -t webcall-api:prod .
# use the prod image by editing docker-compose service 'api' to image: webcall-api:prod
# then
docker compose up -d
```

Check:
```bash
curl -f http://localhost:8000/healthz
open http://<SERVER_IP>:3000   # Grafana
```

Run Alembic migrations (compose already runs them on api start). For manual:
```bash
docker compose exec api alembic upgrade head
```

### Updating
```bash
git pull
DOCKER_BUILDKIT=1 docker build -f docker/api.prod.Dockerfile -t webcall-api:prod .
docker compose up -d --no-deps --build api
```

### Logs
```bash
docker compose logs -f api
```

### Scaling API (stateless layer)
Add replica count using docker compose (v2) or run additional containers behind an external load balancer / nginx upstream.
Ensure:
- Shared Redis
- Shared Postgres
- Sticky sessions NOT required (JWT stateless)

Example with `docker compose up --scale api=2 -d` (adjust if health probing & migration race: move migrations to a one-off job).

## 4. Bare Metal Deployment
Install system packages:
```bash
sudo apt update
sudo apt install -y python3.11 python3.11-venv build-essential libpq-dev redis-server nginx
```
Create user & directory:
```bash
sudo useradd -r -m webcall
sudo mkdir -p /opt/webcall
sudo chown webcall:webcall /opt/webcall
su - webcall
git clone https://your.git/WebCall.git src && cd src/webcall
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install poetry==1.8.3
poetry install --without dev
cp .env.example .env  # fill secrets
alembic upgrade head
```

### Systemd unit
`/etc/systemd/system/webcall.service`:
```
[Unit]
Description=WebCall API
After=network.target

[Service]
User=webcall
Group=webcall
WorkingDirectory=/opt/webcall/src/webcall
Environment=PYTHONPATH=/opt/webcall/src/webcall
EnvironmentFile=/opt/webcall/src/webcall/.env
ExecStart=/opt/webcall/src/webcall/.venv/bin/gunicorn app.bootstrap.asgi:app -k uvicorn.workers.UvicornWorker -w 2 -b 0.0.0.0:8000 --graceful-timeout 30 --timeout 60
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```
Reload & enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webcall
sudo systemctl status webcall
```

### Nginx reverse proxy + TLS
`/etc/nginx/sites-available/webcall.conf`:
```
server {
    listen 80;
    server_name your.domain;
    location / { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
}
```
Enable & test:
```bash
sudo ln -s /etc/nginx/sites-available/webcall.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
Add TLS (Certbot):
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your.domain --redirect --agree-tos -m admin@your.domain
```

## 5. TURN Server (coturn)
If self-hosted (docker-compose already sets one):
1. Open UDP/TCP 3478 + relay ports range (49152-49200).
2. Example coturn service:
```
turnserver --lt-cred-mech --user=$TURN_USERNAME:$TURN_PASSWORD --realm=$TURN_REALM \
  --cert=/etc/letsencrypt/live/your.domain/fullchain.pem --pkey=/etc/letsencrypt/live/your.domain/privkey.pem \
  --fingerprint --log-file=stdout --min-port=49152 --max-port=49200
```
Set env variables so API exposes ICE servers list to clients.

## 6. Observability
Metrics endpoint: `GET /metrics` (Prometheus format).
Provided dashboard: `monitoring/grafana/dashboards/webcall-overview.json`.
Add alert rules via separate Alertmanager (not included).

### Example Prometheus alert rules (add to dedicated rules file):
```
groups:
- name: webcall-alerts
  rules:
    - alert: HighErrorRate
      expr: sum(rate(app_requests_total{status=~"5.."}[5m])) / sum(rate(app_requests_total[5m])) > 0.05
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: ">5% errors (5m)"
    - alert: HighLatencyP95
      expr: histogram_quantile(0.95, sum(rate(app_request_latency_ms_bucket[5m])) by (le)) > 500
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "p95 latency >500ms"
```

## 7. Secrets Management
Use `.env` only for dev. For prod:
- Docker swarm / compose: `env_file` with restricted permissions or secrets store.
- Bare metal: `EnvironmentFile` root-owned (600).

## 8. Backup Strategy
- Postgres: daily `pg_dump` (retain 7-14 days)
- Redis: snapshot (RDB) or use managed Redis
- Versioned infrastructure (IaC) recommended.

## 9. Zero-Downtime Update (compose)
1. Build new image tag (e.g., `webcall-api:2025-09-19`)
2. Update compose `image:` tag.
3. `docker compose up -d api` (old container stops after new healthy).
4. Rollback: revert tag and re-up.

## 10. Troubleshooting
| Symptom | Check |
|---------|-------|
| 503 on auth endpoints | DB not reachable / migrations failed |
| No metrics in Grafana | Prometheus target state, network, `api:8000/metrics` |
| WebRTC fails to connect | TURN credentials / firewall ports |
| High latency | CPU saturation, gunicorn workers too low |

## 11. Hardening Checklist
- Non-root container user (prod Dockerfile uses `app`).
- Remove dev deps in prod image.
- Enable HTTPS everywhere (HSTS auto set in `APP_ENV=prod`).
- Regularly rotate JWT_SECRET (invalidate old tokens if needed).
- Implement WAF / rate limit via Redis already present.

---
This guide can be iterated further with Terraform / Ansible examples if required.
