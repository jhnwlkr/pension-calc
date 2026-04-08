#!/bin/zsh
# Analytics Engine query tool for retirecalc.uk
# Usage: ./query.sh [command]
# Commands: total, countries, users, returning, today, week, month
# Default (no argument): shows all summaries

ACCOUNT="bdedf0872e3d2938693f73171a53fcf7"

# Load token from worker/.env if present, otherwise fall back to wrangler OAuth token
SCRIPT_DIR="${0:a:h}"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  TOKEN=$(grep '^CF_TOKEN=' "$SCRIPT_DIR/.env" | cut -d= -f2-)
else
  TOKEN=$(grep -o 'oauth_token = "[^"]*"' ~/Library/Preferences/.wrangler/config/default.toml 2>/dev/null | grep -o '"[^"]*"$' | tr -d '"')
fi

# GUIDs to exclude from all queries (test entries, own devices, etc.)
EXCLUDE="blob1 NOT IN ('f0b3634f-152a-42b4-bdab-97059d63f275','test-ae-check')"

if [[ -z "$TOKEN" ]]; then
  echo "Error: no API token found. Add CF_TOKEN=... to worker/.env"
  exit 1
fi

query() {
  # Inject EXCLUDE filter before GROUP BY / ORDER BY / LIMIT, or after FROM clause
  local sql="$1"
  if [[ "$sql" == *" WHERE "* ]]; then
    sql="${sql/ WHERE / WHERE $EXCLUDE AND }"
  elif [[ "$sql" == *" GROUP BY"* ]]; then
    sql="${sql/ GROUP BY/ WHERE $EXCLUDE GROUP BY}"
  elif [[ "$sql" == *" ORDER BY"* ]]; then
    sql="${sql/ ORDER BY/ WHERE $EXCLUDE ORDER BY}"
  elif [[ "$sql" == *" LIMIT"* ]]; then
    sql="${sql/ LIMIT/ WHERE $EXCLUDE LIMIT}"
  else
    sql="$sql WHERE $EXCLUDE"
  fi
  curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/analytics_engine/sql" \
    -H "Authorization: Bearer $TOKEN" \
    --data "$sql" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('success', True) or 'errors' in d and d['errors']:
    print('Error:', d.get('errors', d))
    sys.exit(1)
rows = d.get('data', [])
if not rows:
    print('(no data yet)')
    sys.exit(0)
cols = list(rows[0].keys())
widths = [max(len(c), max((len(str(r[c])) for r in rows), default=0)) for c in cols]
fmt = '  '.join(f'{{:<{w}}}' for w in widths)
print(fmt.format(*cols))
print('  '.join('-' * w for w in widths))
for r in rows:
    print(fmt.format(*[str(r[c]) for c in cols]))
print(f'({len(rows)} row(s))')
"
}

DATASET="calc_events"

case "${1:-all}" in

  report)
    echo "=== User report ==="
    query "SELECT blob1 AS client_id, argMax(blob2, timestamp) AS country, argMax(blob3, timestamp) AS device, SUM(_sample_interval) AS calc_runs, MAX(timestamp) AS last_visit, max(if(blob6 LIKE '%pot%', 1, 0)) AS tab_pot, max(if(blob6 LIKE '%annualincome%', 1, 0)) AS tab_annual_income, max(if(blob6 LIKE '%taxbreakdown%', 1, 0)) AS tab_tax, max(if(blob6 LIKE '%realincome%', 1, 0)) AS tab_real_income, max(if(blob6 LIKE '%netmonthly%', 1, 0)) AS tab_net_monthly, max(if(blob6 LIKE '%montecarlo%', 1, 0)) AS tab_monte_carlo, max(if(blob6 LIKE '%historicalreplay%', 1, 0)) AS tab_historical_replay, max(if(blob6 LIKE '%actuals%', 1, 0)) AS tab_actuals FROM $DATASET GROUP BY client_id ORDER BY calc_runs DESC"
    ;;

  total)
    echo "=== Total Calculate clicks ==="
    query "SELECT SUM(_sample_interval) AS total_clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET"
    ;;

  countries)
    echo "=== Clicks by country ==="
    query "SELECT blob2 AS country, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET GROUP BY country ORDER BY clicks DESC"
    ;;

  users)
    echo "=== Top users by click count ==="
    query "SELECT blob1 AS client_id, SUM(_sample_interval) AS clicks, blob2 AS country FROM $DATASET GROUP BY client_id, country ORDER BY clicks DESC LIMIT 50"
    ;;

  returning)
    echo "=== Returning users (>1 day) ==="
    query "SELECT blob1 AS client_id, COUNT(DISTINCT toStartOfDay(timestamp)) AS active_days, SUM(_sample_interval) AS total_clicks FROM $DATASET GROUP BY client_id HAVING active_days > 1 ORDER BY active_days DESC"
    ;;

  repeats)
    echo "=== Repeat visitors (≥15 min between first & last click) ==="
    query "SELECT blob1 AS client_id, SUM(_sample_interval) AS clicks, MIN(timestamp) AS first_click, MAX(timestamp) AS last_click, round(dateDiff('second', MIN(timestamp), MAX(timestamp)) / 60.0, 1) AS gap_minutes FROM $DATASET GROUP BY client_id HAVING clicks >= 2 AND dateDiff('second', MIN(timestamp), MAX(timestamp)) >= 900 ORDER BY gap_minutes DESC"
    ;;

  devices)
    echo "=== Clicks by device ==="
    query "SELECT blob3 AS device, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET GROUP BY device ORDER BY clicks DESC"
    ;;

  referrers)
    echo "=== Clicks by referrer ==="
    query "SELECT blob4 AS referrer, SUM(_sample_interval) AS clicks FROM $DATASET GROUP BY referrer ORDER BY clicks DESC"
    ;;

  tabs)
    echo "=== Active tab when Calculate was clicked ==="
    query "SELECT blob5 AS active_tab, SUM(_sample_interval) AS clicks FROM $DATASET GROUP BY active_tab ORDER BY clicks DESC"
    ;;

  features)
    echo "=== Feature tab usage (tabs visited per session) ==="
    query "SELECT blob5 AS active_tab, SUM(_sample_interval) AS calc_clicks FROM $DATASET WHERE blob5 != '' GROUP BY active_tab ORDER BY calc_clicks DESC"
    ;;

  today)
    echo "=== Today's activity ==="
    query "SELECT SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '1' DAY"
    ;;

  week)
    echo "=== Last 7 days ==="
    query "SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY day ORDER BY day DESC"
    ;;

  month)
    echo "=== Last 30 days ==="
    query "SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY day ORDER BY day DESC"
    ;;

  all)
    echo "=============================="
    echo " retirecalc.uk Analytics"
    echo "=============================="
    echo ""
    echo "=== Totals ==="
    query "SELECT SUM(_sample_interval) AS total_clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET"
    echo ""
    echo "=== Clicks by country ==="
    query "SELECT blob2 AS country, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET GROUP BY country ORDER BY clicks DESC"
    echo ""
    echo "=== Clicks by device ==="
    query "SELECT blob3 AS device, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET GROUP BY device ORDER BY clicks DESC"
    echo ""
    echo "=== Clicks by referrer ==="
    query "SELECT blob4 AS referrer, SUM(_sample_interval) AS clicks FROM $DATASET GROUP BY referrer ORDER BY clicks DESC"
    echo ""
    echo "=== Active tab at Calculate ==="
    query "SELECT blob5 AS active_tab, SUM(_sample_interval) AS clicks FROM $DATASET GROUP BY active_tab ORDER BY clicks DESC"
    echo ""
    echo "=== Last 7 days (daily) ==="
    query "SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS clicks, COUNT(DISTINCT blob1) AS unique_users FROM $DATASET WHERE timestamp > NOW() - INTERVAL '7' DAY GROUP BY day ORDER BY day DESC"
    echo ""
    echo "=== Returning users (>1 active day) ==="
    query "SELECT blob1 AS client_id, COUNT(DISTINCT toStartOfDay(timestamp)) AS active_days, SUM(_sample_interval) AS total_clicks FROM $DATASET GROUP BY client_id HAVING active_days > 1 ORDER BY active_days DESC"
    echo ""
    echo "=== Repeat visitors (≥15 min between first & last click) ==="
    query "SELECT blob1 AS client_id, SUM(_sample_interval) AS clicks, MIN(timestamp) AS first_click, MAX(timestamp) AS last_click, round(dateDiff('second', MIN(timestamp), MAX(timestamp)) / 60.0, 1) AS gap_minutes FROM $DATASET GROUP BY client_id HAVING clicks >= 2 AND dateDiff('second', MIN(timestamp), MAX(timestamp)) >= 900 ORDER BY gap_minutes DESC"
    ;;

  *)
    echo "Usage: $0 [report|total|countries|devices|referrers|tabs|features|users|returning|repeats|today|week|month]"
    echo "       $0          (runs all summaries)"
    exit 1
    ;;
esac
