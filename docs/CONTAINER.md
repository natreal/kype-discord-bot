# Running in a container

`compose.yaml` runs the bot and a PostgreSQL 17 database on a Linux host. The bot opens no
port: it only needs outbound access to Discord, so no reverse proxy or DNS record is involved.

## First deployment

Create a folder holding a copy of `compose.yaml` and a `.env` next to it:

```bash
chmod 600 .env
docker compose up -d
docker compose logs -f bot
```

| `.env` variable     | Value                                                            |
| ------------------- | ---------------------------------------------------------------- |
| `DISCORD_TOKEN`     | Bot token                                                        |
| `DISCORD_CLIENT_ID` | Application ID                                                   |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` (hexadecimal, because it goes into a URL) |

Every other setting in `.env.example` is optional and can be added to the same file.
`DATABASE_URL` and `NODE_ENV` are set by `compose.yaml` and override the file.
Database files are in `./data/postgres`: back them up with `pg_dump`.

Slash commands are published at startup, because `compose.yaml` sets
`COMMANDS_AUTO_DEPLOY=true`.

## Updating

Every push to `main` is built, linted and tested by `.github/workflows/container.yml`, then
published as `ghcr.io/natreal/kype-discord-bot:latest` and `:<commit>`. The first publish creates
a private package: make it public in the package settings, or log the host in to `ghcr.io`.

To deploy on each push, set the `VPS_SSH_PRIVATE_KEY` (base64), `VPS_SSH_KNOWN_HOSTS`,
`VPS_SSH_HOST` and `VPS_SSH_USER` repository secrets. Without them the workflow stops after
publishing, and the host updates with:

```bash
docker compose pull && docker compose up -d
```

Pending migrations are applied each time the container starts, before the bot.
`scripts/docker/entrypoint.sh` does this, and a failed migration keeps the bot down and restarts
the container: read `docker compose logs bot`.

## Commands that behave differently

- `/restart` works: the container exits and Docker starts it again.
- `/stop` works: the bot stops and the container stays up without it. Bring it back with
  `docker compose restart bot`. A host reboot also brings it back.
- `/admin update` is refused, because the Windows deploy task it asks for does not exist here.
  Push to `main` instead.
- `npm run setup:*`, `deploy:*`, `whoami`, `invite` and `monitor` need `tsx`, which the image does
  not include. Run them from a checkout pointed at the same token.

The bot has no health endpoint, so the container reports only that it is running, not that the
Discord session is connected.
