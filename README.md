# Max

**Max** is an open-source AI assistant for legal professionals. It provides an
intelligent chat interface, tabular document-review workflows, a Microsoft Word
add-in, and a Model Context Protocol (MCP) connector framework — all deployable
on your own infrastructure.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

> **Based on [Mike](https://github.com/willchen96/mike)** by Will Chen
> (AGPL-3.0). Max is a substantially modified fork — see [NOTICE](NOTICE) for
> the full upstream attribution.

---

## Features

- **AI chat** — multi-turn chat with documents and context, backed by any of
  the supported LLM providers (Anthropic Claude, Google Gemini, OpenAI,
  OpenRouter, or your own vLLM endpoint).
- **Tabular review** — structured document review with configurable AI-filled
  columns (e.g. NDA parties, risk level, obligations).
- **Workflow packs** — declarative YAML/JSON workflow definitions that can be
  versioned, shared, and contributed back. See [`docs/workflows.md`](docs/workflows.md).
- **Microsoft Word add-in** — task-pane integration that connects Word directly
  to the Max backend.
- **MCP connectors** — plug in any Model Context Protocol server; built-in
  server-side connectors are also supported.
- **Multi-language UI** — ships with English and Croatian; add more locales via
  `frontend/messages/`.

---

## Repository layout

```
backend/          Express API — Cloud SQL, document processing, LLM routing
frontend/         Next.js 16 app (App Router, Turbopack, React Compiler)
word-addin/       Microsoft Word task-pane add-in
mcp-sidecars/     Example MCP sidecar configurations
workflow-packs/   Declarative workflow/prompt-pack definitions
schemas/          JSON Schema for workflow packs
docs/             Documentation (workflows, etc.)
```

> **Not included in this repository:** deployment scripts, third-party
> identity-provider glue code, and local vendor sources are excluded via
> `.gitignore`.

---

## Local development

### Prerequisites

- Node.js ≥ 22
- PostgreSQL (local, [Supabase](https://supabase.com), or
  [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/auth-proxy))
- LibreOffice (for DOC/DOCX → PDF conversion)
- A Google Cloud Storage bucket (GCS) — configured via `GCS_BUCKET_NAME` env var
- At least one LLM provider key (see [LLM configuration](#llm-configuration))

### Install

```bash
npm install --prefix backend
npm install --prefix frontend
npm install --prefix word-addin   # optional, only for the Word add-in
```

### Configure

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Edit each file and fill in your credentials (database URL, API keys, storage
credentials).

### Database

For a fresh database run the one-shot schema:

```bash
psql -h 127.0.0.1 -U <user> -d max -f backend/migrations/000_one_shot_schema.sql
```

For an existing database apply numbered migrations in order:

```bash
psql -h 127.0.0.1 -U <user> -d max -f backend/migrations/001_*.sql
# … continue through the highest-numbered file
```

### Run

```bash
npm run dev --prefix backend     # http://localhost:3001
npm run dev --prefix frontend    # http://localhost:3000
```

### Word add-in (optional)

```bash
cd word-addin
npm install
npm run install-certs   # one-time, self-signed Office certificate
npm run dev             # task pane at https://localhost:3002
```

Sideload `word-addin/manifest.xml` in Microsoft Word, then pair from
**Account → Word add-in** (6-digit code, 5-minute TTL).

---

## LLM configuration

Backend reads provider keys from `backend/.env`:

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `GEMINI_API_KEY` | Google Gemini |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter (multi-provider) |
| `VLLM_BASE_URL` + `VLLM_API_KEY` + `VLLM_MAIN_MODEL` | Self-hosted vLLM |

At least one provider must be configured. The application selects models based
on the keys present.

---

## Workflow packs

Max supports declarative workflow/prompt-pack definitions in YAML format,
validated against `schemas/workflow.schema.json`.

Example layouts ship in `workflow-packs/examples/`. Full documentation is in
[`docs/workflows.md`](docs/workflows.md).

---

## Checks

```bash
npm run build --prefix backend
npm run build --prefix frontend
npm run lint  --prefix frontend
```

---

## Deployment

Max is designed to run on **Google Cloud Run** but can be deployed to any
container platform.

### Environment variables (production)

| Service | Key variables |
|---|---|
| Backend | `DATABASE_URL` or `CLOUD_SQL_CONNECTION_NAME`, `GCS_BUCKET_NAME`, LLM keys |
| Frontend | `NEXT_PUBLIC_API_BASE_URL` (backend URL) |

> **On Cloud Run** the backend uses [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
> for both Cloud SQL and GCS — no additional credentials env-vars are needed
> when the service account has the required IAM roles.

### Built-in MCP connectors

Server-side ("always-on") MCP connectors are declared in `mike/mcp.json`
(gitignored — copy from `mike/mcp.json.example`). Servers listed there are
loaded on every chat request and never appear in the per-user connectors UI.
Environment variables referenced as `${VAR_NAME}` in the file are expanded at
runtime. See [`mike/README.md`](mike/README.md) for the full format.

The example ships two connectors: `eulex` (enabled, requires `EULEX_MCP_JWT_SECRET`)
and `tavily` (disabled by default, requires `TAVILY_API_KEY`).

### Docker

Both `backend/` and `frontend/` ship with a `Dockerfile`. Build and push to
your container registry, then deploy to your platform of choice.

```bash
docker build -t max-backend ./backend
docker build -t max-frontend ./frontend \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://your-backend-url
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to submit patches,
report issues, and sign off contributions with the Developer Certificate of
Origin.

---

## License

Max is licensed under the **GNU Affero General Public License v3.0**
(AGPL-3.0-only). See [LICENSE](LICENSE) for the full text.

AGPL-3.0 requires that if you run a modified version of Max as a network
service you must make the corresponding source code available to the users of
that service. See §13 of the license for details.

Copyright © 2026 Max Contributors
