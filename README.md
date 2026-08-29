# Flash Sale System

A high-throughput flash sale backend (single product, limited stock, one item per user) with a React frontend, fully Dockerized.

## Quick start

Prerequisite: Docker Desktop / Docker Engine with Docker Compose. Nothing else needs to be installed on the host.

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000/api
- Health check: http://localhost:3000/api/health

Full documentation (architecture, schema, concurrency strategy, testing, benchmarks) is finalized in Phase 10.

## Reset development data

```bash
docker compose down -v
docker compose up --build
```
