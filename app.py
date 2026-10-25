"""
Catbot - a voice AI agent with cat personas, built on free services.

  Speech -> text : Groq Whisper (free tier)          POST /api/transcribe
  AI brain       : Groq GPT-OSS + tools (agent loop) POST /api/chat
  Tools          : memory, weather, timers, to-dos, treat jar  (see tools.py)
  Vision         : camera / screen / photos -> Groq Qwen vision model (same tools)
  Text -> speech : Microsoft Edge voices (edge-tts)   POST /api/speak

Your Groq key stays on this server (read from .env). The browser UI lives in ./static.

Run:  python app.py   then open http://localhost:8000
"""

import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

import edge_tts
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import APIError, AsyncOpenAI, AuthenticationError, BadRequestError, RateLimitError
from pydantic import BaseModel, Field

import personas
import tools
from personas import DEFAULT_PERSONA, PERSONAS, system_prompt

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# ---------- settings (override any of these in .env) ----------
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
GROQ_BASE_URL = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
CHAT_MODEL = os.getenv("CHAT_MODEL", "openai/gpt-oss-120b")
# Used in order if CHAT_MODEL isn't available (Groq retires models; Llama 3.3 was retired Aug 2026).
CHAT_FALLBACKS = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]
NOT_CHAT = ("whisper", "tts", "orpheus", "guard", "safeguard", "embed", "playai", "compound")
STT_MODEL = os.getenv("STT_MODEL", "whisper-large-v3-turbo")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "")  # e.g. "en" or "tl"; blank = auto-detect
TTS_VOICE = os.getenv("TTS_VOICE", "en-US-AriaNeural")
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
VISION_MODEL = os.getenv("VISION_MODEL", "qwen/qwen3.8-27b")  # used for turns that include images
VISION_ENABLED = True  # turned off at startup if Groq doesn't offer VISION_MODEL
MAX_IMAGES = 3         # Groq's per-request limit for Qwen vision
MAX_IMAGE_CHARS = 4_000_000  # ~3 MB per base64 image; the browser shrinks images well below this
REASONING_EFFORT = os.getenv("REASONING_EFFORT", "low")  # gpt-oss only: low / medium / high
MAX_HISTORY = 20
MAX_TOOL_ROUNDS = 4  # how many tool steps the agent may take before it must answer

# A short list of good Edge voices. Any voice from `edge-tts --list-voices` works in .env.
VOICES = [
    ("en-US-AriaNeural", "Aria (US)"),
    ("en-US-JennyNeural", "Jenny (US)"),
    ("en-US-AndrewNeural", "Andrew (US)"),
    ("en-US-BrianNeural", "Brian (US)"),
    ("en-US-EmmaNeural", "Emma (US)"),
    ("en-US-AnaNeural", "Ana (US, child)"),
    ("en-US-GuyNeural", "Guy (US)"),
    ("en-GB-SoniaNeural", "Sonia (UK)"),
    ("en-GB-RyanNeural", "Ryan (UK)"),
    ("en-AU-NatashaNeural", "Natasha (Australia)"),
    ("en-PH-RosaNeural", "Rosa (Philippines)"),
    ("en-PH-JamesNeural", "James (Philippines)"),
    ("fil-PH-BlessicaNeural", "Blessica (Filipino)"),
    ("fil-PH-AngeloNeural", "Angelo (Filipino)"),
]
for _v in [TTS_VOICE] + [p["voice"] for p in PERSONAS.values()]:
    if _v not in dict(VOICES):
        VOICES.insert(0, (_v, _v))
VOICE_IDS = {v for v, _ in VOICES}

if not GROQ_API_KEY:
    raise SystemExit(
        "\nGROQ_API_KEY is missing.\n"
        "1. Get a free key at https://console.groq.com/keys\n"
        "2. Open the .env file in this folder and set:  GROQ_API_KEY=gsk_...\n"
    )

client = AsyncOpenAI(api_key=GROQ_API_KEY, base_url=GROQ_BASE_URL)  # Groq speaks the OpenAI API format


async def check_models():
    """Groq retires models now and then. If the configured chat model is gone, pick a close replacement."""
    global CHAT_MODEL, VISION_ENABLED
    try:
        ids = [m.id for m in (await client.models.list()).data]
    except AuthenticationError:
        print("\n  !! Groq rejected GROQ_API_KEY. Check the key in .env.\n")
        return
    except Exception as e:
        print(f"  (couldn't list Groq models: {e})")
        return
    if CHAT_MODEL not in ids:
        chat_ids = [i for i in ids if not any(k in i.lower() for k in NOT_CHAT)]
        pick = next((m for m in CHAT_FALLBACKS if m in ids), None) or (chat_ids[0] if chat_ids else CHAT_MODEL)
        print(f"  Chat model '{CHAT_MODEL}' isn't available on Groq; using '{pick}' instead.")
        CHAT_MODEL = pick
    if STT_MODEL not in ids:
        print(f"  Warning: speech model '{STT_MODEL}' isn't listed. Available: {[i for i in ids if 'whisper' in i]}")
    if VISION_MODEL not in ids:
        VISION_ENABLED = False
        print(f"  Vision model '{VISION_MODEL}' isn't available on your Groq account, so vision is off.")
    print(f"  Chat: {CHAT_MODEL} | Vision: {VISION_MODEL if VISION_ENABLED else 'off'} | "
          f"Speech-to-text: {STT_MODEL} | Voice: {TTS_VOICE}")


@asynccontextmanager
async def lifespan(_app):
    await check_models()
    yield


app = FastAPI(title="Catbot", lifespan=lifespan)


# ---------- request models ----------
class Message(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    persona: str = DEFAULT_PERSONA
    images: list[str] = []   # data:image/...;base64,... attached to the latest user message
    image_source: str = ""   # "camera", "screen" or "photo", so the cat knows what it's looking at


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice: str | None = None
    persona: str | None = None


def api_error(e: Exception) -> HTTPException:
    if isinstance(e, AuthenticationError):
        return HTTPException(401, "Groq rejected the API key. Check GROQ_API_KEY in .env.")
    if isinstance(e, RateLimitError):
        return HTTPException(429, "Groq's free-tier limit was reached. Wait a minute and try again.")
    if isinstance(e, APIError):
        return HTTPException(502, f"Groq error: {e.message}")
    return HTTPException(500, str(e))


# ---------- API ----------
@app.get("/api/config")
async def config():
    return {
        "voices": [{"id": v, "label": l} for v, l in VOICES],
        "voice": TTS_VOICE,
        "chat_model": CHAT_MODEL,
        "vision": VISION_ENABLED,
        "vision_model": VISION_MODEL,
        "max_images": MAX_IMAGES,
        "default_persona": DEFAULT_PERSONA,
        "personas": [
            {"id": pid, "name": p["name"], "tagline": p["tagline"], "voice": p["voice"], "greeting": p["greeting"]}
            for pid, p in PERSONAS.items()
        ],
    }


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    data = await audio.read()
    if len(data) < 1000:  # too short to contain speech
        return {"text": ""}
    mime = (audio.content_type or "audio/wav").split(";")[0]
    extra = {"language": STT_LANGUAGE} if STT_LANGUAGE else {}
    try:
        result = await client.audio.transcriptions.create(
            model=STT_MODEL, file=(audio.filename or "speech.wav", data, mime), **extra
        )
    except Exception as e:
        raise api_error(e)
    return {"text": result.text.strip()}


LEAKED_TAGS = re.compile(r"<think>[\s\S]*?</think>|<function[\s\S]*?</function>|<\|.*?\|>", re.I)


def friendly(e: Exception) -> str:
    return api_error(e).detail


async def complete(messages, tool_schemas, allow_tools=True, model=None):
    """One model call. Retries once if the model garbles a tool call, then falls back to no tools."""
    model = model or CHAT_MODEL
    kwargs = {"model": model, "messages": messages, "temperature": 0.7}
    if model.startswith("openai/gpt-oss"):
        kwargs["reasoning_effort"] = REASONING_EFFORT  # keep thinking short so voice replies stay snappy
    if tool_schemas and allow_tools:
        kwargs |= {"tools": tool_schemas, "tool_choice": "auto"}
    for attempt in range(2):
        try:
            return (await client.chat.completions.create(**kwargs)).choices[0].message
        except BadRequestError as e:
            if "tool_use_failed" not in str(e):
                raise
            print(f"[agent] model garbled a tool call (attempt {attempt + 1})")
    kwargs.pop("tools", None), kwargs.pop("tool_choice", None)
    return (await client.chat.completions.create(**kwargs)).choices[0].message


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """The agent loop. Streams newline-delimited JSON events:
    {"type":"tool", ...} for each tool used, {"type":"state", ...} for the side panel,
    {"type":"text","text": ...} for the reply, {"type":"error","message": ...} on failure."""
    persona = personas.get(req.persona)
    tool_schemas = [tools.SCHEMAS[n] for n in persona.get("tools", []) if n in tools.SCHEMAS]
    messages = [{"role": "system", "content": system_prompt(req.persona, tools.context_block())}]
    messages += [m.model_dump() for m in req.messages[-MAX_HISTORY:]]

    # Vision: attach images to the latest user message and switch this turn to the vision model.
    images = [i for i in req.images if i.startswith("data:image/") and len(i) <= MAX_IMAGE_CHARS][:MAX_IMAGES]
    model = CHAT_MODEL
    if images and VISION_ENABLED and messages[-1]["role"] == "user":
        where = {"camera": "a live frame from the user's camera",
                 "screen": "a screenshot of the user's screen",
                 "photo": "a photo the user shared"}.get(req.image_source, "an image the user shared")
        messages[0]["content"] += "\n\n" + personas.VISION_RULES
        messages[-1]["content"] = (
            [{"type": "text", "text": f"[Attached: {where}]\n{messages[-1]['content']}"}]
            + [{"type": "image_url", "image_url": {"url": img}} for img in images]
        )
        model = VISION_MODEL

    async def gen():
        ev = lambda obj: json.dumps(obj, ensure_ascii=False) + "\n"
        used_tools = False
        try:
            for rnd in range(MAX_TOOL_ROUNDS + 1):
                msg = await complete(messages, tool_schemas, allow_tools=rnd < MAX_TOOL_ROUNDS, model=model)
                if not msg.tool_calls:
                    text = LEAKED_TAGS.sub("", msg.content or "").strip()
                    if used_tools:
                        yield ev({"type": "state", **tools.snapshot()})
                    yield ev({"type": "text", "text": text or "..."})
                    return
                messages.append({
                    "role": "assistant", "content": msg.content or "",
                    "tool_calls": [{"id": c.id, "type": "function",
                                    "function": {"name": c.function.name, "arguments": c.function.arguments or "{}"}}
                                   for c in msg.tool_calls],
                })
                for call in msg.tool_calls:
                    try:
                        args = json.loads(call.function.arguments or "{}") or {}
                    except json.JSONDecodeError:
                        args = {}
                    if call.function.name not in persona.get("tools", []):
                        result = {"ok": False, "error": "that tool isn't available to you"}
                    else:
                        result = await tools.run_tool(call.function.name, args)
                    used_tools = True
                    print(f"[agent] {persona['name']} used {call.function.name}({args}) -> ok={result.get('ok')}")
                    yield ev({"type": "tool", "name": call.function.name, "args": args, "ok": bool(result.get("ok"))})
                    messages.append({"role": "tool", "tool_call_id": call.id,
                                     "content": json.dumps(result, ensure_ascii=False, default=str)})
        except Exception as e:
            msg = friendly(e)
            if images and isinstance(e, BadRequestError):
                msg += " (The vision model couldn't read that image. Try a smaller or different picture.)"
            yield ev({"type": "error", "message": msg})

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ---------- side panel: state + direct actions from the UI ----------
@app.get("/api/state")
async def state():
    return tools.snapshot()


@app.get("/api/timers/due")
async def due_timers(persona: str = DEFAULT_PERSONA):
    p = personas.get(persona)
    fired = tools.pop_due_timers()
    return {"due": [{"label": t["label"], "text": p["reminder"].format(label=t["label"])} for t in fired],
            "state": tools.snapshot() if fired else None}


@app.post("/api/todos/{item_id}/complete")
async def ui_complete_todo(item_id: str):
    return {"result": await tools.complete_todo(item_id), "state": tools.snapshot()}


@app.delete("/api/todos/{item_id}")
async def ui_remove_todo(item_id: str):
    return {"result": await tools.remove_todo(item_id), "state": tools.snapshot()}


@app.delete("/api/timers/{item_id}")
async def ui_cancel_timer(item_id: str):
    return {"result": await tools.cancel_timer(item_id), "state": tools.snapshot()}


@app.delete("/api/memory/{item_id}")
async def ui_forget(item_id: str):
    return {"result": await tools.forget_memory(item_id), "state": tools.snapshot()}


@app.post("/api/speak")
async def speak(req: SpeakRequest):
    persona = PERSONAS.get(req.persona or "", {})
    voice = req.voice if req.voice in VOICE_IDS else persona.get("voice", TTS_VOICE)
    # Persona speed/pitch apply only with the persona's own voice, so other voices sound natural.
    tweaks = {"rate": persona.get("rate", "+0%"), "pitch": persona.get("pitch", "+0Hz")} if voice == persona.get("voice") else {}
    try:
        audio = bytearray()
        async for chunk in edge_tts.Communicate(req.text, voice, **tweaks).stream():
            if chunk["type"] == "audio":
                audio.extend(chunk["data"])
    except Exception as e:
        raise HTTPException(502, f"Text-to-speech failed (edge-tts needs internet): {e}")
    if not audio:
        raise HTTPException(502, "Text-to-speech returned no audio.")
    return Response(content=bytes(audio), media_type="audio/mpeg")


# ---------- UI ----------
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


if __name__ == "__main__":
    import uvicorn

    print(f"\n  Catbot is running:  http://localhost:{PORT}\n")
    uvicorn.run(app, host=HOST, port=PORT)
