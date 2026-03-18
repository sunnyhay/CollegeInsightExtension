#!/usr/bin/env python3
"""
Offline Analysis Script for Smart Proxy Telemetry

Reads JSONL routing logs from ~/.openclaw/logs/ and generates a summary report:
- Per-tier request distribution
- Model usage and latency statistics
- Escalation rates and patterns
- Failure analysis
- Routing weight drift

Usage:
  python3 analyze-routing.py                  # All logs
  python3 analyze-routing.py --date 2026-03-17  # Specific date
  python3 analyze-routing.py --last 7           # Last 7 days
"""
import json
import sys
import os
import glob
from datetime import datetime, timedelta
from collections import defaultdict

LOG_DIR = os.path.expanduser("~/.openclaw/logs")
WEIGHTS_FILE = os.path.join(LOG_DIR, "routing-weights.json")


def load_events(date_filter=None, last_days=None):
    events = []
    pattern = os.path.join(LOG_DIR, "routing-*.jsonl")
    files = sorted(glob.glob(pattern))

    if date_filter:
        files = [f for f in files if date_filter in os.path.basename(f)]
    elif last_days:
        cutoff = (datetime.now() - timedelta(days=last_days)).strftime("%Y-%m-%d")
        files = [
            f
            for f in files
            if os.path.basename(f).replace("routing-", "").replace(".jsonl", "")
            >= cutoff
        ]

    for filepath in files:
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass

    return events


def analyze(events):
    if not events:
        print("No events found.")
        return

    print(f"\n{'='*60}")
    print(f"  Smart Proxy Routing Analysis — {len(events)} events")
    print(f"{'='*60}\n")

    # ── Per-tier stats ──
    tier_stats = defaultdict(lambda: {"count": 0, "latencies": [], "models": defaultdict(int), "escalations": 0, "failures": 0})

    for e in events:
        tier = e.get("tier", "?")
        ts = tier_stats[tier]
        ts["count"] += 1
        if "latencyMs" in e:
            ts["latencies"].append(e["latencyMs"])
        model = e.get("modelActual", e.get("modelSelected", "?"))
        ts["models"][model] += 1
        if e.get("escalated"):
            ts["escalations"] += 1
        if e.get("httpStatus", 200) >= 400 or e.get("error"):
            ts["failures"] += 1

    print("── Per-Tier Summary ──\n")
    for tier in sorted(tier_stats.keys()):
        ts = tier_stats[tier]
        lats = ts["latencies"]
        avg_lat = sum(lats) // len(lats) if lats else 0
        min_lat = min(lats) if lats else 0
        max_lat = max(lats) if lats else 0
        esc_rate = (ts["escalations"] / ts["count"] * 100) if ts["count"] > 0 else 0
        fail_rate = (ts["failures"] / ts["count"] * 100) if ts["count"] > 0 else 0

        print(f"  Tier {tier}: {ts['count']} requests")
        print(f"    Latency: avg {avg_lat}ms, min {min_lat}ms, max {max_lat}ms")
        print(f"    Escalations: {ts['escalations']} ({esc_rate:.1f}%)")
        print(f"    Failures: {ts['failures']} ({fail_rate:.1f}%)")
        print(f"    Models: {dict(ts['models'])}")
        print()

    # ── Model usage ──
    model_stats = defaultdict(lambda: {"count": 0, "latencies": [], "successes": 0})
    for e in events:
        model = e.get("modelActual", e.get("modelSelected", "?"))
        ms = model_stats[model]
        ms["count"] += 1
        if "latencyMs" in e:
            ms["latencies"].append(e["latencyMs"])
        if e.get("httpStatus", 200) == 200 and not e.get("error"):
            ms["successes"] += 1

    print("── Model Usage ──\n")
    for model, ms in sorted(model_stats.items(), key=lambda x: -x[1]["count"]):
        lats = ms["latencies"]
        avg = sum(lats) // len(lats) if lats else 0
        success_rate = (ms["successes"] / ms["count"] * 100) if ms["count"] > 0 else 0
        print(f"  {model}: {ms['count']} calls, avg {avg}ms, {success_rate:.1f}% success")
    print()

    # ── Top escalation reasons ──
    esc_reasons = defaultdict(int)
    for e in events:
        if e.get("escalated"):
            esc_reasons[e.get("escalationReason", "unknown")] += 1

    if esc_reasons:
        print("── Escalation Reasons ──\n")
        for reason, count in sorted(esc_reasons.items(), key=lambda x: -x[1]):
            print(f"  {reason}: {count}")
        print()

    # ── Tier classification reasons ──
    class_reasons = defaultdict(int)
    for e in events:
        class_reasons[e.get("tierReason", "unknown")] += 1

    print("── Classification Reasons ──\n")
    for reason, count in sorted(class_reasons.items(), key=lambda x: -x[1]):
        print(f"  {reason}: {count}")
    print()

    # ── Current routing weights ──
    if os.path.exists(WEIGHTS_FILE):
        print("── Current Routing Weights ──\n")
        with open(WEIGHTS_FILE) as f:
            weights = json.load(f)
        for tier, models in sorted(weights.items()):
            parts = [f"{m}: {w:.3f}" for m, w in sorted(models.items(), key=lambda x: -x[1])]
            print(f"  {tier}: {', '.join(parts)}")
        print()

    # ── Time distribution ──
    hours = defaultdict(int)
    for e in events:
        ts = e.get("timestamp", "")
        if "T" in ts:
            hour = ts.split("T")[1][:2]
            hours[hour] += 1

    if hours:
        print("── Hourly Distribution ──\n")
        for h in sorted(hours.keys()):
            bar = "█" * (hours[h] // max(1, max(hours.values()) // 30))
            print(f"  {h}:00  {bar} {hours[h]}")
        print()

    print(f"{'='*60}")
    print(f"  Analysis complete. {len(events)} events processed.")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    date_filter = None
    last_days = None

    for i, arg in enumerate(sys.argv[1:], 1):
        if arg == "--date" and i < len(sys.argv) - 1:
            date_filter = sys.argv[i + 1]
        elif arg == "--last" and i < len(sys.argv) - 1:
            last_days = int(sys.argv[i + 1])

    events = load_events(date_filter, last_days)
    analyze(events)
