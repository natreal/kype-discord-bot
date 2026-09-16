# CI

PostgreSQL is not needed for unit tests: `DatabaseService` is substituted with an
in-memory stub, so the suite runs with `DATABASE_URL` pointing at nothing.
The `db-smoke` step below is the one place that needs a real server.

## Local database check

```bash
npm run db:migrate:deploy   # apply migrations
npm run db:smoke -- --cleanup
```
