#!/usr/bin/env python3
"""
Snapshot Wynncraft's lootrun camp reward pools into data/lootpools.json.

The Wynncraft API only allows browser requests from wynncraft.com (CORS), so
the site can't call it directly. A scheduled GitHub Action runs this script
and commits the result, which the site then serves as a static file.

The file is only rewritten when the pools actually change, so scheduled runs
that find nothing new produce no commit.

Mythic rewards also get a `subType` (dagger, boots, ...) from the item API so
the page can show the right texture. Types already in the previous file are
reused, so only new mythics are looked up.

Shiny rewards also get a `shinyTracker` (e.g. "Mobs Killed") from Wynnventory's
pool data, since the Wynncraft API doesn't say what a shiny tracks. This needs
WYNNVENTORY_API_KEY; without it (or if Wynnventory fails) trackers from the
previous file are kept for camps whose pools haven't changed.

With --wait, a run started in the hours around Friday's reset keeps polling
until the new pools appear (see wait_for_new_pools). GitHub often skips
scheduled runs, so this way any one run that does start before the reset is
enough.

Usage: WYNNVENTORY_API_KEY=... python3 scripts/update_lootpools.py [--wait]
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

API_URL = "https://api.wynncraft.com/v3/map/loot-pools"
ITEM_SEARCH_URL = "https://api.wynncraft.com/v3/item/search/"
OUT = Path(__file__).resolve().parent.parent / "data" / "lootpools.json"
REWARD_KEYS = ("name", "type", "amount", "tier", "shiny")
WYNNVENTORY_POOLS_URL = "https://wynnventory.com/api/v2/lootpools"


def fetch(url=API_URL, attempts=3, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "wynndex-lootpool-updater", **(headers or {})})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except Exception as err:  # noqa: BLE001 - retry on anything, then give up
            print(f"Fetch attempt {i + 1} failed: {err}", file=sys.stderr)
            if i + 1 < attempts:
                time.sleep(10 * (i + 1))
    raise SystemExit(f"Could not fetch {url}")


def lookup_subtype(name):
    """Item subtype (e.g. "dagger", "boots") for an exact item name, or None."""
    try:
        results = fetch(ITEM_SEARCH_URL + urllib.parse.quote(name), attempts=2)
    except SystemExit as err:
        print(err, file=sys.stderr)
        return None
    if isinstance(results, dict):  # keyed by name in some API versions
        results = list(results.values())
    for item in results or []:
        if isinstance(item, dict) and str(item.get("displayName", item.get("internalName", ""))).lower() == name.lower():
            return item.get("subType")
    return None


def add_subtypes(camps, previous):
    """Set `subType` on mythic rewards, reusing ones from the previous file."""
    known = {
        r["name"]: r["subType"]
        for c in previous.get("camps", [])
        for r in c.get("rewards", [])
        if r.get("subType")
    }
    for camp in camps:
        for reward in camp["rewards"]:
            if reward.get("tier") != "MYTHIC":
                continue
            name = reward["name"]
            if name not in known:
                known[name] = lookup_subtype(name)
                print(f"Looked up {name}: {known[name]}")
            if known[name]:
                reward["subType"] = known[name]


NY = ZoneInfo("America/New_York")
RESET_HOUR = 14  # pools reset Fridays 2 PM New York time

# --wait: poll from this long before the reset until this long after it.
WAIT_BEFORE = timedelta(hours=3)
WAIT_AFTER = timedelta(minutes=90)
POLL_SECONDS = 60


def reset_on_or_before(ny):
    """The Friday reset on or before New York-local `ny` (no later than it)."""
    day = ny - timedelta(days=(ny.weekday() - 4) % 7)
    reset = datetime(day.year, day.month, day.day, RESET_HOUR, tzinfo=NY)
    if reset > ny:
        day -= timedelta(days=7)
        reset = datetime(day.year, day.month, day.day, RESET_HOUR, tzinfo=NY)
    return reset


def last_reset(now=None):
    """Most recent pool reset, in UTC."""
    ny = (now or datetime.now(timezone.utc)).astimezone(NY)
    return reset_on_or_before(ny).astimezone(timezone.utc)


def nearest_reset(now):
    """The pool reset closest to `now` (past or upcoming), in UTC."""
    ny = now.astimezone(NY)
    past = reset_on_or_before(ny)
    nxt = reset_on_or_before(ny + timedelta(days=7))
    best = min((past, nxt), key=lambda r: abs(r - ny))
    return best.astimezone(timezone.utc)


def parse_time(text):
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None


def wv_group(groups, camp_name):
    """Wynnventory names camps more briefly ("Corkus" for "The Corkus Traversal")."""
    name = camp_name.lower()
    matches = [g for g in groups if str(g.get("name", "")).lower() in name]
    return max(matches, key=lambda g: len(g["name"]), default=None)


def shinies_of(group):
    """(item name, tracker) pairs for a Wynnventory pool group's shinies."""
    pairs = []
    for item in (group or {}).get("items", []):
        stat = item.get("shiny_stat") or {}
        tracker = (stat.get("statType") or {}).get("displayName")
        if item.get("shiny") and tracker:
            pairs.append((item.get("name"), tracker))
    return pairs


def add_shiny_trackers(camps):
    """Set `shinyTracker` on shiny rewards from Wynnventory. Returns False if
    Wynnventory couldn't be used at all.

    Wynnventory's pool for the current week often still lists last week's shiny
    too, sometimes the same item with a different tracker (Shiny Idol -> Shiny
    Idol). So for each camp, drop shinies whose (name, tracker) also appears in
    that camp's previous week, then take the one Wynncraft names.
    """
    key = os.environ.get("WYNNVENTORY_API_KEY", "").strip()
    if not key:
        print("No WYNNVENTORY_API_KEY; skipping shiny trackers", file=sys.stderr)
        return False
    try:
        weeks = fetch(WYNNVENTORY_POOLS_URL, attempts=2, headers={"X-API-Key": key}).get("data") or []
    except (SystemExit, AttributeError) as err:
        print(f"Wynnventory pools unavailable: {err}", file=sys.stderr)
        return False
    weeks.sort(key=lambda w: (w.get("year", 0), w.get("week", 0)), reverse=True)
    if not weeks:
        return False

    reset = last_reset()
    current_groups = weeks[0].get("groups") or []
    previous_groups = weeks[1].get("groups") or [] if len(weeks) > 1 else []
    for camp in camps:
        group = wv_group(current_groups, camp["name"])
        # Data from before this week's reset is last week's pool.
        stamp = parse_time((group or {}).get("timestamp"))
        if not group or not stamp or stamp < reset:
            continue
        stale = set(shinies_of(wv_group(previous_groups, camp["name"])))
        candidates = shinies_of(group)
        fresh = [p for p in candidates if p not in stale]
        for reward in camp["rewards"]:
            if not reward.get("shiny"):
                continue
            name = str(reward["name"]).lower()
            # Same shiny and tracker two weeks running: nothing fresh, but the
            # stale entry is then also right.
            for pool in (fresh, candidates):
                hit = next((t for n, t in pool if str(n).lower() == name), None)
                if hit:
                    reward["shinyTracker"] = hit
                    break
    return True


def keep_shiny_trackers(camps, previous):
    """Reuse trackers from the previous file for camps whose pools are unchanged."""
    def strip(rewards):
        return [{k: v for k, v in r.items() if k != "shinyTracker"} for r in rewards]

    old = {c["name"]: c.get("rewards", []) for c in previous.get("camps", [])}
    for camp in camps:
        before = old.get(camp["name"])
        if before is None or strip(before) != strip(camp["rewards"]):
            continue
        trackers = {r["name"]: r["shinyTracker"] for r in before if r.get("shinyTracker")}
        for reward in camp["rewards"]:
            if reward.get("shiny") and reward["name"] in trackers and "shinyTracker" not in reward:
                reward["shinyTracker"] = trackers[reward["name"]]


def fetch_camps():
    raw = fetch()
    camps = [
        {
            "name": pool["name"],
            "internalName": pool.get("internalName"),
            "rewards": [{k: r[k] for k in REWARD_KEYS if k in r} for r in pool.get("rewards", [])],
        }
        for pool in raw
        if pool.get("type") == "CAMP"
    ]
    if not camps or not any(c["rewards"] for c in camps):
        raise SystemExit("API returned no camp rewards; not overwriting")
    return camps


def bare(camps):
    """Camps without the fields this script adds, for comparing with the API."""
    return [
        {**c, "rewards": [{k: r[k] for k in REWARD_KEYS if k in r} for r in c.get("rewards", [])]}
        for c in camps
    ]


def wait_for_new_pools(camps, previous):
    """Near a reset whose pools we don't have yet, re-fetch every minute until
    the API's pools differ from the previous file, or the window ends."""
    now = datetime.now(timezone.utc)
    reset = nearest_reset(now)
    start, deadline = reset - WAIT_BEFORE, reset + WAIT_AFTER
    if not start <= now < deadline:
        return camps
    # Treat a write shortly before the reset as this reset's pools too, in
    # case they changed a little early.
    written = parse_time(previous.get("updated_at"))
    if written and written >= reset - timedelta(minutes=15):
        print(f"Already have pools from the {reset:%Y-%m-%d %H:%M} UTC reset")
        return camps
    old = bare(previous.get("camps", []))
    print(f"Waiting for the {reset:%Y-%m-%d %H:%M} UTC reset (until {deadline:%H:%M} UTC)")
    while camps == old:
        if datetime.now(timezone.utc) + timedelta(seconds=POLL_SECONDS) >= deadline:
            print("Gave up waiting; pools still unchanged")
            break
        time.sleep(POLL_SECONDS)
        try:
            camps = fetch_camps()
        except SystemExit as err:  # keep waiting through API hiccups
            print(err, file=sys.stderr)
    return camps


def main():
    camps = fetch_camps()

    try:
        previous = json.loads(OUT.read_text())
    except (OSError, ValueError):
        previous = {}

    if "--wait" in sys.argv[1:]:
        camps = wait_for_new_pools(camps, previous)

    add_subtypes(camps, previous)
    add_shiny_trackers(camps)
    # Trackers Wynnventory didn't give this run (no key, error, or no fresh
    # data yet) stay as they were while the pool is unchanged.
    keep_shiny_trackers(camps, previous)

    if previous.get("camps") == camps:
        print("Loot pools unchanged")
        return

    OUT.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": API_URL,
        "camps": camps,
    }
    OUT.write_text(json.dumps(data, indent=1) + "\n")
    print(f"Wrote {len(camps)} camps to {OUT}")


if __name__ == "__main__":
    main()
