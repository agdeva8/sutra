#!/bin/sh
# After a deploy: is the API up, ready, and serving the new routes? Usage: smoke.sh https://api.example.com
set -e
BASE="${1:?usage: smoke.sh https://api-host}"
ok() { echo "ok   $1"; }
fail() { echo "FAIL $1"; exit 1; }
code() { curl -s -o /dev/null -w "%{http_code}" -X "${2:-GET}" -H "Origin: $BASE" "$BASE$1"; }

[ "$(code /health)" = "200" ] && ok "/health" || fail "/health"
[ "$(code /ready)" = "200" ] && ok "/ready (database reachable)" || fail "/ready"
# These need a login, so 401 (not 404 or 500) is the pass: the route exists and is guarded.
for r in /api/scratch /api/recurring /api/agent/progress; do
  [ "$(code $r)" = "401" ] && ok "$r guarded" || fail "$r (expected 401)"
done
[ "$(code /api/chat/plan POST)" = "401" ] && ok "/api/chat/plan guarded" || fail "/api/chat/plan"
echo "smoke passed"
