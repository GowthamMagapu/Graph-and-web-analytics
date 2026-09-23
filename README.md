# GraphPulse

Graph-powered web & product analytics for SaaS businesses. Visitor activity is
streamed in real time and modelled as a graph (Visitors → Sessions → Pages /
Goals), so journeys, funnels and drop-offs are graph traversals rather than
expensive relational joins.

## Architecture

```
 Client websites          Ingestion & streaming         Processing           Dual-store layer            Dashboard & API
┌───────────────┐  POST  ┌────────────────────┐ Kafka ┌──────────────┐   ┌─────────────────────┐  GraphQL ┌──────────────┐
│ tracker.js    │──────▶│ ingest (Express)    │──────▶│ worker       │──▶│ Neo4j  (graph)      │◀─────────│ api (Yoga)   │◀── React UI
│ snippet       │       │ validate, tenant key│ gp.   │ sequence,    │   │ Postgres (event log)│          │ JWT + RBAC   │    (Vite)
└───────────────┘       └────────────────────┘ events│ enrich, alert│   │ Redis (real-time)   │          └──────────────┘
                                                      └──────────────┘   └─────────────────────┘
```

| Layer | Code | Notes |
|---|---|---|
| Tracking snippet | [tracker/graphpulse.js](tracker/graphpulse.js) | ~1 KB, sessions (30-min idle), SPA route changes, `track()` / `convert()`, batched `sendBeacon` |
| Ingestion gateway | [server/src/ingest.js](server/src/ingest.js) | Validates events ([lib/events.js](server/src/lib/events.js)), resolves the tenant by API key, publishes to Kafka keyed by session |
| Stream worker | [server/src/worker.js](server/src/worker.js), [pipeline.js](server/src/pipeline.js) | Idempotent writes to Postgres + Neo4j + Redis; per-minute alert checks ([alerts.js](server/src/alerts.js)) |
| GraphQL API | [server/src/api.js](server/src/api.js), [schema.js](server/src/schema.js) | Login → JWT; every resolver is tenant-scoped from the token; viewer / analyst / admin roles |
| Dashboard | [web/](web/) | React + Recharts + d3-force: KPIs, real-time, traffic, journey graph, funnel builder, drop-offs, alerts |

### The graph model

```
(:Visitor)-[:STARTED]->(:Session)-[:VIEWED {ts, seq}]->(:Page)
                              ├──-[:CONVERTED {ts}]->(:Goal)
                              └──-[:TRIGGERED {ts}]->(:EventType)
(:Page)-[:NAVIGATED_TO {count}]->(:Page)
```

Every node carries `tenantId` and is unique per tenant. Funnels are one
multi-hop Cypher query ([lib/funnel.js](server/src/lib/funnel.js)); journeys come
from consecutive `VIEWED` edges; drop-offs from each session's last view.

## Quick start (lite mode - no Docker)

Needs only **Node.js 22.13+**. The whole platform runs as one process on one port:

```bash
npm run setup
```

```bash
npm run lite
```

Open http://localhost:4000 and sign in as `admin@demo.local` with password `graphpulse`.
On the first start, a week of demo traffic is generated automatically. After that,
`npm run lite:start` starts the app without rebuilding the dashboard.

Lite mode keeps the same dashboard, API, tracker and graph model. It swaps each
database for a built-in stand-in:

| Full version | Lite mode |
|---|---|
| Kafka | direct in-process calls |
| Postgres | SQLite (Node's built-in `node:sqlite`), stored in `data/graphpulse.db` |
| Neo4j | in-memory graph ([server/src/lite/memgraph.js](server/src/lite/memgraph.js)), rebuilt from SQLite on start |
| Redis | in-memory real-time counters |

It's great for demos and development. The full Docker version below shows the
scalable architecture from the deck.

To start over with fresh demo data, stop the server, delete the `data/` folder and run `npm run lite:start` again.

## Track a real website (free hosting on Render)

1. Push this project to a GitHub repository.
2. On [render.com](https://render.com), choose **New → Blueprint** and select the repository. [render.yaml](render.yaml) configures everything.
3. When prompted, enter `ADMIN_EMAIL` and `ADMIN_PASSWORD`. These become your dashboard login. The login-token secret and the site key are generated for you.
4. Open `https://<your-service>.onrender.com`, sign in, and copy the snippet from the **Install** tab.
5. Paste the snippet into the `<head>` of every page on your website. Visits then appear on the dashboard in real time.

In production the server refuses to start without these settings, and no demo users or fake traffic are created.

Free-plan caveats:
- The service sleeps after 15 minutes without traffic. The first visit after that takes about a minute to wake it.
- The disk is wiped whenever the service restarts or redeploys, so stored history is lost.

For permanent history, attach a Render persistent disk (paid) and set `LITE_DB` to a path on it.

## Full version (Docker)

Prerequisites: Node.js 22+ and Docker Desktop.

```bash
npm run setup
```

```bash
npm run infra:up
```

```bash
npm run migrate
```

```bash
npm run dev
```

- Dashboard: http://localhost:5173. Sign in as `admin@demo.local` with password `graphpulse`. `analyst@` and `viewer@demo.local` also exist, for testing roles.
- GraphQL playground: http://localhost:4001/graphql (send `Authorization: Bearer <token>`)
- Instrumented demo site: http://localhost:4000/demo/index.html
- Neo4j browser: http://localhost:7474 (user `neo4j`, password `graphpulse123`)

### Generate traffic

```bash
npm run simulate -- --backfill 7 --sessions 4000
```

```bash
npm run simulate -- --live --rate 2 --spike-after 900
```

The first command generates a week of history. The second streams live
traffic and injects a 10x spike after 15 minutes. That's long enough for
the anomaly rule to build a baseline, so the spike should fire the
"Traffic anomaly" alert.

### Tests

```bash
npm test
```

### Everything in containers

```bash
docker compose --profile app up -d --build
```

This runs migrate, ingest, two worker replicas and the API. Start the UI with `npm run dev:web`.

## Configuration

Copy [server/.env.example](server/.env.example) to `server/.env`. The defaults
match `docker-compose.yml` (Postgres is on host port **5433** to avoid clashing
with a local install). Alert channels: `log`, `slack` (incoming-webhook URL),
`webhook` (any HTTPS endpoint, e.g. Zapier) and `email` (needs `SMTP_*`).

## Status vs. the project deck

| Deck item | Status |
|---|---|
| Real-time ingestion (JS snippet → REST → Kafka) | ✅ |
| Graph modelling (Neo4j) + Postgres + Redis | ✅ |
| Journey graph, funnels, drop-off detection | ✅ |
| Custom dashboards (drag-and-drop, per-user layout) | ✅ |
| Threshold + anomaly alerts, Slack / email / webhooks | ✅ |
| Multi-tenancy + RBAC + JWT | ✅ (API-key per tenant, token-scoped queries) |
| Docker | ✅ (`docker-compose.yml`) |
| OAuth 2.0 / SSO, TLS termination | ⏳ next |
| Kubernetes manifests, Prometheus / Grafana | ⏳ next |
| Scheduled PDF/email reports, GA / CRM integrations | ⏳ next |
| Cohort discovery, ML churn prediction, mobile SDK | ⏳ future scope |
