"""
The cats' tools. Each tool is a plain Python function plus a JSON schema the AI model reads.

  Cat Brain              save_memory, forget_memory        (memories are also added to every prompt)
  Window Watch           get_weather                        (Open-Meteo, free, no key)
  Nap Timer              set_timer, list_timers, cancel_timer
  Knock It Off the Table add_todo, complete_todo, list_todos, remove_todo
  Treat Jar (Jianyu)     give_treat, check_treat_jar

Everything is saved as JSON in ./data so it survives restarts.
To add a tool: write an async function, add its schema to SCHEMAS, add it to FUNCTIONS,
and list its name under "tools" for the personas that may use it (personas.py).
"""

import json
import os
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
TZ = ZoneInfo(os.getenv("TIMEZONE", "Asia/Manila"))
HOME_CITY = os.getenv("HOME_CITY", "Manila")
_lock = threading.Lock()


# ---------- tiny JSON store ----------
def _load(name, default):
    path = DATA_DIR / f"{name}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save(name, value):
    with _lock:
        tmp = DATA_DIR / f"{name}.json.tmp"
        tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(DATA_DIR / f"{name}.json")


def _short_id():
    return uuid.uuid4().hex[:6]


def now():
    return datetime.now(TZ)


def _match(items, ref, key="text"):
    """Find an item by id, by number in the list (1-based), or by fuzzy text match."""
    ref = str(ref).strip().lower()
    for it in items:
        if it["id"] == ref:
            return it
    if ref.isdigit() and 0 < int(ref) <= len(items):
        return items[int(ref) - 1]
    for it in items:
        if ref and (ref in it[key].lower() or it[key].lower() in ref):
            return it
    return None


# ---------- Cat Brain (memory) ----------
def memories():
    return _load("memory", [])


async def save_memory(fact: str):
    mem = memories()
    if any(m["text"].lower() == fact.lower() for m in mem):
        return {"ok": True, "note": "already remembered"}
    mem.append({"id": _short_id(), "text": fact, "saved": now().strftime("%Y-%m-%d")})
    _save("memory", mem)
    return {"ok": True, "remembered": fact}


async def forget_memory(fact: str):
    mem = memories()
    hit = _match(mem, fact)
    if not hit:
        return {"ok": False, "error": "no matching memory", "memories": [m["text"] for m in mem]}
    mem.remove(hit)
    _save("memory", mem)
    return {"ok": True, "forgot": hit["text"]}


# ---------- Window Watch (weather) ----------
WEATHER_CODES = {
    0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain",
    65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow",
    75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "violent rain showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
}


async def get_weather(location: str = "", days: int = 1):
    place = (location or HOME_CITY).strip()
    days = max(1, min(int(days or 1), 7))
    async with httpx.AsyncClient(timeout=10) as http:
        geo = (await http.get("https://geocoding-api.open-meteo.com/v1/search",
                              params={"name": place.split(",")[0], "count": 1})).json()
        if not geo.get("results"):
            return {"ok": False, "error": f"couldn't find a place called {place}"}
        g = geo["results"][0]
        wx = (await http.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": g["latitude"], "longitude": g["longitude"], "timezone": "auto",
            "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
            "hourly": "precipitation_probability", "forecast_days": days,
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
        })).json()
    cur = wx["current"]
    # rain chance for the rest of today, hour by hour
    hours = wx["hourly"]["time"]
    probs = wx["hourly"]["precipitation_probability"]
    now_iso = cur["time"][:13]
    upcoming = [(h[11:16], p) for h, p in zip(hours, probs) if h[:13] >= now_iso and h[:10] == cur["time"][:10]]
    peak = max(upcoming, key=lambda x: x[1] or 0) if upcoming else None
    daily = wx["daily"]
    return {
        "ok": True,
        "place": f'{g["name"]}, {g.get("country", "")}'.strip(", "),
        "now": {
            "condition": WEATHER_CODES.get(cur["weather_code"], "unknown"),
            "temp_c": cur["temperature_2m"], "feels_like_c": cur["apparent_temperature"],
            "humidity_pct": cur["relative_humidity_2m"], "wind_kmh": cur["wind_speed_10m"],
        },
        "rest_of_today_peak_rain_chance": {"time": peak[0], "pct": peak[1]} if peak else None,
        "days": [
            {"date": d, "condition": WEATHER_CODES.get(c, "unknown"), "high_c": hi, "low_c": lo, "rain_chance_pct": rp}
            for d, c, hi, lo, rp in zip(daily["time"], daily["weather_code"], daily["temperature_2m_max"],
                                        daily["temperature_2m_min"], daily["precipitation_probability_max"])
        ],
    }


# ---------- Nap Timer (timers & reminders) ----------
def timers():
    return _load("timers", [])


async def set_timer(label: str, in_minutes: float = 0, at: str = ""):
    if at:
        try:
            due = datetime.strptime(at.strip(), "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
        except ValueError:
            try:  # "17:30" -> today (or tomorrow if already past)
                t = datetime.strptime(at.strip(), "%H:%M").time()
                due = now().replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
                if due <= now():
                    due += timedelta(days=1)
            except ValueError:
                return {"ok": False, "error": "use 'at' as 'YYYY-MM-DD HH:MM' or 'HH:MM', or use in_minutes"}
    elif in_minutes and float(in_minutes) > 0:
        due = now() + timedelta(minutes=float(in_minutes))
    else:
        return {"ok": False, "error": "need in_minutes or at"}
    ts = timers()
    item = {"id": _short_id(), "label": label, "due": due.timestamp(), "due_local": due.strftime("%Y-%m-%d %H:%M")}
    ts.append(item)
    _save("timers", ts)
    return {"ok": True, "timer": {"label": label, "goes_off_at": item["due_local"]}}


async def list_timers():
    ts = sorted(timers(), key=lambda t: t["due"])
    left = lambda t: max(0, round((t["due"] - time.time()) / 60, 1))
    return {"ok": True, "timers": [{"id": t["id"], "label": t["label"], "at": t["due_local"], "minutes_left": left(t)} for t in ts]}


async def cancel_timer(which: str):
    ts = timers()
    hit = _match(ts, which, key="label")
    if not hit:
        return {"ok": False, "error": "no matching timer"}
    ts.remove(hit)
    _save("timers", ts)
    return {"ok": True, "cancelled": hit["label"]}


def pop_due_timers():
    ts = timers()
    due = [t for t in ts if t["due"] <= time.time()]
    if due:
        _save("timers", [t for t in ts if t not in due])
    return due


# ---------- Knock It Off the Table (to-dos) ----------
def todos():
    return _load("todos", [])


async def add_todo(task: str):
    items = todos()
    items.append({"id": _short_id(), "text": task, "done": False, "added": now().strftime("%Y-%m-%d")})
    _save("todos", items)
    return {"ok": True, "added": task, "open_tasks": sum(not t["done"] for t in items)}


async def complete_todo(task: str):
    items = todos()
    hit = _match([t for t in items if not t["done"]], task)
    if not hit:
        return {"ok": False, "error": "no matching open task", "open": [t["text"] for t in items if not t["done"]]}
    hit["done"] = True
    hit["done_at"] = now().strftime("%Y-%m-%d %H:%M")
    _save("todos", items)
    jar = _load("treats", {"owed": 0, "eaten": 0, "history": []})
    jar["owed"] += 1  # Jianyu claims a treat for every finished task
    _save("treats", jar)
    return {"ok": True, "knocked_off_the_table": hit["text"], "jianyu_treats_owed": jar["owed"]}


async def list_todos():
    items = todos()
    return {"ok": True, "open": [t["text"] for t in items if not t["done"]],
            "done_recently": [t["text"] for t in items if t["done"]][-5:]}


async def remove_todo(task: str):
    items = todos()
    hit = _match(items, task)
    if not hit:
        return {"ok": False, "error": "no matching task"}
    items.remove(hit)
    _save("todos", items)
    return {"ok": True, "removed": hit["text"]}


# ---------- Treat Jar (Jianyu) ----------
def treat_jar():
    return _load("treats", {"owed": 0, "eaten": 0, "history": []})


async def give_treat(snack: str):
    jar = treat_jar()
    jar["eaten"] += 1
    jar["owed"] = max(0, jar["owed"] - 1)
    jar["history"] = (jar["history"] + [{"snack": snack, "at": now().strftime("%Y-%m-%d %H:%M")}])[-20:]
    _save("treats", jar)
    return {"ok": True, "ate": snack, "treats_eaten_total": jar["eaten"], "still_owed": jar["owed"]}


async def check_treat_jar():
    jar = treat_jar()
    return {"ok": True, "treats_eaten_total": jar["eaten"], "treats_owed": jar["owed"],
            "recent_snacks": [h["snack"] for h in jar["history"][-5:]]}


# ---------- schemas the model sees ----------
def _fn(name, description, props=None, required=None):
    return {"type": "function", "function": {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": props or {}, "required": required or []}}}


SCHEMAS = {
    "save_memory": _fn("save_memory", "Remember a lasting fact about the user (name, birthday, likes, plans, people in their life). Use whenever they share something worth remembering.",
                       {"fact": {"type": "string", "description": "The fact, written as a short sentence, e.g. 'User's name is Vann'"}}, ["fact"]),
    "forget_memory": _fn("forget_memory", "Forget a saved fact when the user asks or it's no longer true.",
                         {"fact": {"type": "string", "description": "Words from the memory to forget"}}, ["fact"]),
    "get_weather": _fn("get_weather", "Get current weather, today's rain chance and a forecast. Defaults to the user's home city.",
                       {"location": {"type": "string", "description": "City name; leave empty for the user's home city"},
                        "days": {"type": "integer", "description": "Days of forecast, 1-7 (default 1)"}}),
    "set_timer": _fn("set_timer", "Set a timer or reminder. The cat will announce it out loud when it goes off.",
                     {"label": {"type": "string", "description": "What to remind about, e.g. 'check the rice'"},
                      "in_minutes": {"type": "number", "description": "Minutes from now"},
                      "at": {"type": "string", "description": "Clock time 'HH:MM' (24h) or 'YYYY-MM-DD HH:MM', local time"}}, ["label"]),
    "list_timers": _fn("list_timers", "List active timers and reminders."),
    "cancel_timer": _fn("cancel_timer", "Cancel a timer or reminder.",
                        {"which": {"type": "string", "description": "Label words or id of the timer"}}, ["which"]),
    "add_todo": _fn("add_todo", "Add a task to the user's to-do list.",
                    {"task": {"type": "string"}}, ["task"]),
    "complete_todo": _fn("complete_todo", "Mark a task done (knock it off the table!).",
                         {"task": {"type": "string", "description": "Task words, id, or its number in the list"}}, ["task"]),
    "list_todos": _fn("list_todos", "Show the user's to-do list."),
    "remove_todo": _fn("remove_todo", "Delete a task without completing it.",
                       {"task": {"type": "string"}}, ["task"]),
    "give_treat": _fn("give_treat", "Record that the user gave Jianyu a treat or snack (even a pretend one).",
                      {"snack": {"type": "string", "description": "What the snack was"}}, ["snack"]),
    "check_treat_jar": _fn("check_treat_jar", "Check how many treats Jianyu has eaten and how many the user still owes."),
}

FUNCTIONS = {
    "save_memory": save_memory, "forget_memory": forget_memory, "get_weather": get_weather,
    "set_timer": set_timer, "list_timers": list_timers, "cancel_timer": cancel_timer,
    "add_todo": add_todo, "complete_todo": complete_todo, "list_todos": list_todos, "remove_todo": remove_todo,
    "give_treat": give_treat, "check_treat_jar": check_treat_jar,
}


async def run_tool(name: str, args: dict):
    fn = FUNCTIONS.get(name)
    if not fn:
        return {"ok": False, "error": f"unknown tool {name}"}
    try:
        return await fn(**{k: v for k, v in (args or {}).items() if v is not None})
    except TypeError as e:
        return {"ok": False, "error": f"bad arguments: {e}"}
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"network problem: {e}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def snapshot():
    """Everything the side panel shows."""
    return {
        "todos": todos(),
        "timers": sorted(timers(), key=lambda t: t["due"]),
        "treats": treat_jar(),
        "memories": memories(),
    }


def context_block():
    """Live facts added to the system prompt each turn."""
    mem = memories()
    lines = [f"Current local time: {now().strftime('%A, %B %d, %Y, %H:%M')} ({TZ.key}). User's home city: {HOME_CITY}."]
    if mem:
        lines.append("Things you remember about the user:\n" + "\n".join(f"- {m['text']}" for m in mem))
    else:
        lines.append("You don't know anything about the user yet. If they share their name or other personal details, save them.")
    open_tasks = [t["text"] for t in todos() if not t["done"]]
    if open_tasks:
        lines.append("User's open to-dos: " + "; ".join(open_tasks))
    return "\n\n".join(lines)
