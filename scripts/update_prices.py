#!/usr/bin/env python3
"""
Snapshot Wynnventory market prices for every item in the current camp pools
into data/prices.json, so the reroll page has prices without a personal key.

Run hourly by .github/workflows/prices.yml. The Wynnventory API key comes from
the WYNNVENTORY_API_KEY environment variable (a GitHub Actions secret); it is
never written anywhere. Requests are spaced one second apart.

Items are the mythics, augments and wards in data/lootpools.json, keyed by the
same display name the page uses. Shinies are skipped (their prices are always
typed by hand). If an item's request fails, its previous entry is kept. The file
is only rewritten when the prices change.

Usage: WYNNVENTORY_API_KEY=... python3 scripts/update_prices.py
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_BASE = "https://wynnventory.com/api/v2"
ROOT = Path(__file__).resolve().parent.parent
POOLS = ROOT / "data" / "lootpools.json"
OUT = ROOT / "data" / "prices.json"
DELAY = 1.0  # seconds between requests

# Keep in sync with AUGMENT_NAMES in reroll/reroll.js.
AUGMENT_NAMES = {"corkian simulator", "corkian insulator"}
# Only the fields the page reads.
STAT_KEYS = (
    "unidentified_lowest_price",
    "lowest_price",
    "unidentified_average_p50_ema_price",
    "average_p50_ema_price",
    "unidentified_count",
    "total_count",
)


def display_name(name):
    """Same as displayName() in reroll.js: "CORKIAN INSULATOR" -> "Corkian Insulator"."""
    if name != name.upper():
        return name
    return re.sub(r"\b\w", lambda m: m.group(0).upper(), name.lower())


def priced_items(pools):
    names = set()
    for camp in pools.get("camps", []):
        for r in camp.get("rewards", []):
            name = r.get("name")
            if not name or r.get("shiny"):
                continue
            if name.lower() in AUGMENT_NAMES or r.get("type") == "WARD" or r.get("tier") == "MYTHIC":
                names.add(display_name(name))
    return sorted(names)


def fetch_price(name, key):
    """Returns the item's stats dict, None if Wynnventory has no data, or raises."""
    url = f"{API_BASE}/market/items/{urllib.parse.quote(name)}/price"
    req = urllib.request.Request(url, headers={"X-API-Key": key, "User-Agent": "wynndex-price-updater"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            body = json.load(res)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return None
        raise
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        return None
    return {k: data[k] for k in STAT_KEYS if data.get(k) is not None}


def main():
    key = os.environ.get("WYNNVENTORY_API_KEY", "").strip()
    if not key:
        raise SystemExit("WYNNVENTORY_API_KEY is not set")

    names = priced_items(json.loads(POOLS.read_text()))
    if not names:
        raise SystemExit("No items in data/lootpools.json")

    try:
        previous = json.loads(OUT.read_text())
    except (OSError, ValueError):
        previous = {}
    old_items = previous.get("items", {})

    items = {}
    failed = 0
    for i, name in enumerate(names):
        if i:
            time.sleep(DELAY)
        try:
            stats = fetch_price(name, key)
        except urllib.error.HTTPError as err:
            if err.code in (401, 403):
                raise SystemExit(f"Wynnventory refused the key (HTTP {err.code}); needs the read:market scope")
            print(f"{name}: HTTP {err.code}, keeping previous price", file=sys.stderr)
            failed += 1
            stats = old_items.get(name)
        except Exception as err:  # noqa: BLE001 - network hiccup: keep the old value
            print(f"{name}: {err}, keeping previous price", file=sys.stderr)
            failed += 1
            stats = old_items.get(name)
        if stats:
            items[name] = stats
        print(f"{name}: {'ok' if stats else 'no data'}")

    if failed == len(names):
        raise SystemExit("Every request failed; not overwriting")

    if previous.get("items") == items:
        print("Prices unchanged")
        return

    OUT.write_text(json.dumps({
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": API_BASE,
        "items": items,
    }, indent=1, sort_keys=False) + "\n")
    print(f"Wrote {len(items)} prices to {OUT}")


if __name__ == "__main__":
    main()
