#!/bin/sh
# Applies pending migrations, then runs the bot and acts as its supervisor.
#
# The restart policy brings the container back after any exit, a clean one included,
# so the exit code cannot tell Docker what the bot meant:
#   - `/restart` and crashes exit non-zero: leave, and Docker starts a new run.
#   - `/stop` exits 0: stay up without the bot, or Docker would undo the stop.
#     `docker compose restart bot` starts it again, and so does a host reboot.
set -eu

bot=""
stopping=0
trap 'stopping=1; [ -z "$bot" ] || kill -TERM "$bot" 2>/dev/null || true' TERM INT

node_modules/.bin/prisma migrate deploy
[ "$stopping" = 0 ] || exit 0

node dist/index.js &
bot=$!

code=0
wait "$bot" || code=$?
# A signal interrupts `wait` while the bot is still shutting down.
while [ "$stopping" = 1 ] && kill -0 "$bot" 2>/dev/null; do
  code=0
  wait "$bot" || code=$?
done

[ "$stopping" = 0 ] || exit "$code"
[ "$code" = 0 ] || exit "$code"

echo "Bot stopped from Discord. Start it again with: docker compose restart bot"
trap 'exit 0' TERM INT
while :; do
  sleep 3600 &
  wait $! || true
done
