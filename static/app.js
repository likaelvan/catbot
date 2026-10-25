// Catbot front end: records your voice, sends it to the Python server,
// streams the reply, and plays it back with OpenAI voices.
(() => {
  const $ = id => document.getElementById(id);
  const log = $("log"), input = $("input"), micBtn = $("micBtn"), sendBtn = $("sendBtn"), stopBtn = $("stopBtn");

  // Voice-activity detection tuning
  const SILENCE_MS = 1200;      // stop recording after this much quiet once you've spoken
  const NO_SPEECH_MS = 8000;    // give up if you say nothing for this long
  const MAX_RECORD_MS = 60000;  // hard cap per turn

  let history = [];             // [{role, content}]
  let personas = {}, persona = null, voiceIds = [];
  let state = "idle", busy = false, turnId = 0, chatCtl = null;

  // ---------- status ----------
  function setState(s, head, sub){
    state = s; $("status").dataset.s = s;
    $("statusText").textContent = {idle:"Ready",listening:"Listening",transcribing:"Transcribing",thinking:"Thinking",speaking:"Speaking"}[s];
    if (head) $("stageHead").textContent = head;
    if (sub !== undefined) $("stageSub").textContent = sub;
    micBtn.setAttribute("aria-pressed", s === "listening" ? "true" : "false");
    stopBtn.hidden = !(s === "thinking" || s === "speaking" || s === "transcribing");
  }
  const holder = el => el.closest(".row") || el.closest(".msg");   // the bubble's outer element in the log
  const icon = id => (window.PERSONA_ICONS || {})[id] || (window.PERSONA_ICONS || {})._default || "";
  function add(kind, text, imgs){
    const d = document.createElement("div"); d.className = "msg " + kind;
    if (kind !== "note"){ const t = document.createElement("span"); t.className = "tag"; t.textContent = kind === "me" ? "You" : (persona?.name || "AI"); d.appendChild(t); }
    if (imgs?.length){   // images you showed the cat
      const shots = document.createElement("div"); shots.className = "shots";
      imgs.forEach(u => { const im = new Image(); im.src = u; im.alt = "What you showed"; shots.appendChild(im); });
      d.appendChild(shots);
    }
    const body = document.createElement("span"); body.textContent = text; d.appendChild(body);
    if (kind === "ai"){   // AI messages get the persona's little face beside them
      const row = document.createElement("div"); row.className = "row ai";
      const mini = document.createElement("span"); mini.className = "mini"; mini.innerHTML = icon(persona?.id);
      row.append(mini, d); log.appendChild(row);
    } else log.appendChild(d);
    log.scrollTop = log.scrollHeight; return body;
  }

  // ---------- orb (reacts to your mic level and to playback) ----------
  const orb = $("orb"), cx = orb.getContext("2d");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tok = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  let level = 0;
  function draw(t){
    const w = orb.width, c = w/2; cx.clearRect(0,0,w,w);
    const col = state === "listening" ? tok("--live") : state === "idle" ? tok("--muted") : tok("--accent");
    const base = state === "idle" ? 2 : state === "speaking" ? 12 : 6;
    const amp = base + (state === "listening" ? Math.min(level * 400, 18) : 0);
    for (let ring = 3; ring >= 0; ring--){
      cx.beginPath();
      for (let a = 0; a <= Math.PI*2 + 0.01; a += 0.05){
        const r = 34 + ring*12 + (reduce ? 0 : Math.sin(a*(3+ring) + t*0.006*(1+ring*0.3)) * amp * (1 - ring*0.18));
        const x = c + Math.cos(a)*r, y = c + Math.sin(a)*r;
        a === 0 ? cx.moveTo(x,y) : cx.lineTo(x,y);
      }
      cx.globalAlpha = ring === 0 ? 0.95 : 0.16 + (3-ring)*0.08;
      cx.fillStyle = col; cx.fill();
    }
    cx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // ---------- config ----------
  const ls = { get(k){ try { return localStorage.getItem("vannai-" + k); } catch(e){ return null; } },
              set(k, v){ try { localStorage.setItem("vannai-" + k, v); } catch(e){} } };
  fetch("/api/config").then(r => r.json()).then(cfg => {
    const sel = $("voiceSel");
    voiceIds = cfg.voices.map(v => v.id);
    cfg.voices.forEach(v => { const o = document.createElement("option"); o.value = v.id; o.textContent = v.label; sel.appendChild(o); });
    $("modelInfo").textContent = cfg.chat_model + " on Groq";
    vision.enabled = !!cfg.vision; vision.max = cfg.max_images || 3;
    $("eyeBtn").hidden = !vision.enabled;
    if (vision.enabled) $("modelInfo").title = "Vision: " + cfg.vision_model;
    const nav = $("personas");
    cfg.personas.forEach(p => {
      personas[p.id] = p;
      const b = document.createElement("button"); b.type = "button"; b.className = "persona"; b.dataset.id = p.id;
      b.setAttribute("aria-pressed","false");
      b.innerHTML = '<span class="av"></span><span><b></b><small></small></span>';
      b.querySelector(".av").innerHTML = icon(p.id); b.querySelector("b").textContent = p.name; b.querySelector("small").textContent = p.tagline;
      b.onclick = () => selectPersona(p.id);
      nav.appendChild(b);
    });
    const saved = ls.get("persona");
    selectPersona(personas[saved] ? saved : cfg.default_persona);
  }).catch(() => add("note","Can't reach the server. Is app.py running?"));
  $("voiceSel").onchange = e => ls.set("voice-" + persona.id, e.target.value);

  function selectPersona(id){
    if (persona?.id === id && history.length) return;
    turnId++; chatCtl?.abort(); stopPlayback(); stopListening(false);
    persona = personas[id]; ls.set("persona", id);
    document.documentElement.dataset.persona = id;
    document.title = persona.name + " · Catbot";
    $("orbFace").innerHTML = icon(id);
    document.querySelectorAll(".persona").forEach(b => b.setAttribute("aria-pressed", b.dataset.id === id ? "true" : "false"));
    const v = ls.get("voice-" + id); $("voiceSel").value = voiceIds.includes(v) ? v : persona.voice;
    history = []; log.innerHTML = ""; add("ai", persona.greeting);
    busy = false; sendBtn.disabled = false;
    setState("idle", "Talk to " + persona.name, "Tap the mic and speak. " + persona.name + " answers out loud.");
  }

  // ---------- microphone + recording ----------
  let stream = null, audioCtx = null, analyser = null, recorder = null, chunks = [], vadTimer = null;
  async function ensureMic(){
    if (stream) return true;
    if (!navigator.mediaDevices?.getUserMedia){ add("note","This browser can't record audio. Use Chrome, Edge or Firefox at http://localhost:8000."); return false; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
    } catch(e){
      add("note","Microphone access was blocked. Allow it from the icon in your address bar, then tap the mic again.");
      return false;
    }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    return true;
  }
  function rms(){
    const buf = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v*v; return Math.sqrt(s / buf.length);
  }

  async function startListening(){
    if (busy || recorder) return;
    stopPlayback();
    if (!(await ensureMic())) return;
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const mime = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg"].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
    recorder = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined);
    chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

    // Voice activity detection: learn the room's noise floor, then watch for speech and silence.
    const started = performance.now();
    let noise = 0.01, spoke = false, lastVoice = 0, frames = 0;
    vadTimer = setInterval(() => {
      const now = performance.now(); level = rms(); frames++;
      if (frames < 8) { noise = Math.max(noise, level); return; }          // ~0.4s calibration
      const threshold = Math.max(0.015, noise * 2.2);
      if (level > threshold){ spoke = true; lastVoice = now; }
      else if (!spoke) noise = noise * 0.98 + level * 0.02;
      if ((spoke && now - lastVoice > SILENCE_MS) || (!spoke && now - started > NO_SPEECH_MS) || now - started > MAX_RECORD_MS)
        stopListening(spoke);
    }, 50);

    recorder.onstop = async () => {
      const keep = recorder._keep; recorder = null;
      const blob = new Blob(chunks, {type: chunks[0]?.type || mime || "audio/webm"});
      if (!keep){ setState("idle","Tap the mic to talk","I didn't hear anything."); return; }
      await transcribeAndSend(blob);
    };
    recorder.start(250);
    setState("listening","Listening…","Speak now. I'll send when you pause. Tap the mic to send early.");
  }
  function stopListening(keep){
    clearInterval(vadTimer); vadTimer = null; level = 0;
    if (recorder && recorder.state !== "inactive"){ recorder._keep = keep; recorder.stop(); }
  }
  micBtn.onclick = () => {
    if (recorder) stopListening(true);
    else { if (state === "speaking") stopPlayback(); startListening(); }
  };

  // Convert the browser recording (WebM/MP4) to a 16 kHz mono WAV, which every OpenAI model accepts.
  async function toWav(blob){
    const decoded = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000, length = Math.ceil(decoded.duration * rate);
    const off = new OfflineAudioContext(1, length, rate);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0,"RIFF"); v.setUint32(4, 36 + pcm.length*2, true); str(8,"WAVE"); str(12,"fmt ");
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true); v.setUint32(24,rate,true);
    v.setUint32(28,rate*2,true); v.setUint16(32,2,true); v.setUint16(34,16,true); str(36,"data"); v.setUint32(40,pcm.length*2,true);
    for (let i = 0; i < pcm.length; i++){ const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i*2, s < 0 ? s*0x8000 : s*0x7fff, true); }
    return new Blob([buf], {type:"audio/wav"});
  }

  async function transcribeAndSend(blob){
    setState("transcribing","Transcribing…","");
    const fd = new FormData();
    try { fd.append("audio", await toWav(blob), "speech.wav"); }
    catch(e){ const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm"; fd.append("audio", blob, "speech." + ext); }
    try {
      const r = await fetch("/api/transcribe", {method:"POST", body:fd});
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || "Transcription failed.");
      if (!j.text){ setState("idle","Tap the mic to talk","I couldn't make out any words. Try again."); if ($("handsFree").checked) startListening(); return; }
      send(j.text);
    } catch(e){ add("note", e.message); setState("idle","Tap the mic to talk",""); }
  }

  // ---------- playback queue: fetch speech per sentence, play in order ----------
  let playQueue = [], playing = null, playTurn = 0;
  function queueSpeech(text, tid){
    text = text.trim(); if (!text || !$("autoSpeak").checked) return;
    const audioPromise = fetch("/api/speak", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({text, voice:$("voiceSel").value, persona: persona?.id})})
      .then(r => r.ok ? r.blob() : null).catch(() => null);
    playQueue.push({audioPromise, tid});
    if (!playing) playNext();
  }
  async function playNext(){
    const item = playQueue.shift();
    if (!item){ playing = null; onPlaybackDone(); return; }
    playing = item;
    const blob = await item.audioPromise;
    if (item.tid !== turnId || !blob){ playNext(); return; }
    if (state !== "speaking") setState("speaking","Speaking…","Tap the mic to interrupt.");
    const url = URL.createObjectURL(blob), a = new Audio(url);
    item.audio = a;
    a.onended = a.onerror = () => { URL.revokeObjectURL(url); playNext(); };
    a.play().catch(() => playNext());
  }
  function stopPlayback(){
    playQueue = []; if (playing?.audio){ playing.audio.onended = null; playing.audio.pause(); } playing = null;
  }
  let replyFinished = true;
  function onPlaybackDone(){
    if (!replyFinished || busy) return;
    setState("idle","Your turn","Tap the mic or type.");
    if ($("handsFree").checked) startListening();
  }

  // ---------- chat ----------
  async function send(text){
    if (busy || (!text && !vision.attached.length)) return;
    const shot = vision.collect();                     // camera/screen frame and/or attached photos
    if (!text) text = "What do you think of this?";
    const tid = ++turnId; busy = true; replyFinished = false; sendBtn.disabled = true;
    input.value = ""; autosize();
    add("me", text, shot.images);
    const histText = shot.images.length ? text + ` [showed ${shot.images.length} image${shot.images.length > 1 ? "s" : ""} from ${shot.source}]` : text;
    history.push({role:"user", content: histText});
    const bubble = add("ai","…");
    setState("thinking","Thinking…","");
    chatCtl = new AbortController();

    let reply = "", pending = "";
    const flush = final => {      // hand complete sentences to the speech queue as they stream in
      const re = /[^.!?\n]+[.!?\n]+["')\]]*\s*/g; let m, last = 0;
      while ((m = re.exec(pending))){ if (m[0].trim().length > 1) queueSpeech(m[0], tid); last = re.lastIndex; }
      pending = pending.slice(last);
      if (final){ queueSpeech(pending, tid); pending = ""; }
    };
    try {
      const r = await fetch("/api/chat", {method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({messages: history, persona: persona?.id, images: shot.images, image_source: shot.source}), signal: chatCtl.signal});
      if (!r.ok){ let d = ""; try { d = (await r.json()).detail; } catch(_){} throw new Error(d || "Chat request failed (" + r.status + ")."); }
      // The server streams one JSON event per line: tool steps, panel state, then the reply.
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
      const handle = ev => {
        if (ev.type === "tool"){
          toolChip(ev, bubble);
          setState("thinking", TOOL_LABELS[ev.name]?.[0] || "Working…", "");
        } else if (ev.type === "state"){ renderState(ev); }
        else if (ev.type === "text"){
          reply += ev.text; pending += ev.text; bubble.textContent = reply; log.scrollTop = log.scrollHeight; flush(false);
        } else if (ev.type === "error"){ throw new Error(ev.message); }
      };
      while (true){
        const {done, value} = await reader.read(); if (done) break;
        buf += dec.decode(value, {stream:true});
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) if (line.trim()) handle(JSON.parse(line));
      }
      if (buf.trim()) handle(JSON.parse(buf));
      flush(true);
      history.push({role:"assistant", content:reply || "(no reply)"});
    } catch(e){
      if (e.name === "AbortError"){ bubble.textContent = reply || "(stopped)"; if (reply) history.push({role:"assistant", content:reply}); else history.pop(); }
      else { history.pop(); holder(bubble).remove(); add("note", e.message); }
    }
    busy = false; sendBtn.disabled = false; replyFinished = true;
    if (tid !== turnId) return;
    if (!playing && !playQueue.length){
      setState("idle","Your turn","Tap the mic or type.");
      if (reply && $("handsFree").checked && !chatCtl.signal.aborted) startListening();
    }
  }

  stopBtn.onclick = () => { turnId++; chatCtl?.abort(); stopPlayback(); stopListening(false); setState("idle","Stopped","Tap the mic or type."); };
  $("dock").addEventListener("submit", e => { e.preventDefault(); send(input.value.trim()); });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); send(input.value.trim()); } });
  function autosize(){ input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; }
  input.addEventListener("input", autosize);
  $("clearBtn").onclick = () => { stopBtn.onclick(); history = []; log.innerHTML = ""; add("ai", persona?.greeting || "Fresh start."); setState("idle","Talk to " + (persona?.name || "Catbot"),""); };

  // ---------- agent tools: chips in the chat ----------
  const TOOL_LABELS = {
    save_memory:     ["Saving to Cat Brain…", "Saved to Cat Brain"],
    forget_memory:   ["Forgetting…", "Forgot something"],
    get_weather:     ["Peeking out the window…", "Checked the weather"],
    set_timer:       ["Setting a nap timer…", "Set a timer"],
    list_timers:     ["Checking timers…", "Checked timers"],
    cancel_timer:    ["Cancelling timer…", "Cancelled a timer"],
    add_todo:        ["Putting it on the table…", "Added a to-do"],
    complete_todo:   ["Knocking it off the table…", "Knocked it off the table"],
    list_todos:      ["Looking at the table…", "Checked the to-dos"],
    remove_todo:     ["Removing task…", "Removed a to-do"],
    give_treat:      ["Nom nom…", "Treat into the jar"],
    check_treat_jar: ["Counting treats…", "Checked the treat jar"],
  };
  function toolChip(ev, bubble){
    const chip = document.createElement("div");
    chip.className = "tool-chip" + (ev.ok ? "" : " failed");
    chip.textContent = (TOOL_LABELS[ev.name]?.[1] || ev.name) + (ev.ok ? "" : " (didn't work)");
    const anchor = holder(bubble);
    log.insertBefore(chip, anchor);
  }

  // ---------- side panel: to-dos, timers, treat jar, memories ----------
  let panelState = {todos:[], timers:[], treats:{owed:0, eaten:0, history:[]}, memories:[]};
  const esc = t => { const d = document.createElement("div"); d.textContent = t; return d.innerHTML; };
  function fmtLeft(sec){
    if (sec <= 0) return "now";
    const h = Math.floor(sec/3600), m = Math.floor(sec%3600/60), s2 = Math.floor(sec%60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${String(s2).padStart(2,"0")}s` : `${s2}s`;
  }
  async function renderState(st){
    const prevOpen = new Set(panelState.todos.filter(t => !t.done).map(t => t.id));
    const knocked = st.todos.filter(t => t.done && prevOpen.has(t.id));
    for (const t of knocked){                         // play the knock-off-the-table animation first
      const li = document.querySelector(`#todoList li[data-id="${t.id}"]`);
      if (li) li.classList.add("knock");
    }
    if (knocked.length) await new Promise(r => setTimeout(r, 650));
    panelState = st;

    const open = st.todos.filter(t => !t.done), done = st.todos.filter(t => t.done).slice(-3).reverse();
    $("todoCount").textContent = open.length || "";
    $("todoList").innerHTML = open.length ? open.map(t =>
      `<li data-id="${t.id}"><button class="check" data-act="done" title="Knock it off the table" aria-label="Complete"></button>
        <span>${esc(t.text)}</span><button class="x" data-act="del" aria-label="Remove">×</button></li>`).join("")
      : `<li class="empty">Nothing on the table. Say "add buy cat food to my to-dos".</li>`;
    $("doneList").innerHTML = done.map(t => `<li>${esc(t.text)}</li>`).join("");

    $("timerCount").textContent = st.timers.length || "";
    $("timerList").innerHTML = st.timers.length ? st.timers.map(t =>
      `<li data-id="${t.id}"><span class="left" data-due="${t.due}">${fmtLeft(t.due - Date.now()/1000)}</span>
        <span>${esc(t.label)}</span><button class="x" data-act="cancel" aria-label="Cancel">×</button></li>`).join("")
      : `<li class="empty">No timers. Try "remind me in 10 minutes to stretch".</li>`;

    const tr = st.treats || {owed:0, eaten:0, history:[]};
    const fill = (tr.eaten % 10) / 10 || (tr.eaten ? 1 : 0);
    $("jarFill").setAttribute("y", 22 + 56 * (1 - fill)); $("jarFill").setAttribute("height", 56 * fill);
    $("jarEaten").textContent = tr.eaten;
    $("jarOwed").textContent = tr.owed ? `You owe Jianyu ${tr.owed} treat${tr.owed > 1 ? "s" : ""}` : "All treats paid. For now.";
    $("jarRecent").textContent = tr.history.length ? "Last: " + tr.history.slice(-3).reverse().map(h => h.snack).join(", ") : "";

    $("memCount").textContent = st.memories.length || "";
    $("memList").innerHTML = st.memories.length ? st.memories.map(m =>
      `<li data-id="${m.id}"><span>${esc(m.text)}</span><button class="x" data-act="forget" aria-label="Forget">×</button></li>`).join("")
      : `<li class="empty">Nothing yet. Tell them your name or what you like.</li>`;
  }
  async function panelAction(url, method){
    try { const r = await fetch(url, {method}); const j = await r.json(); if (j.state) renderState(j.state); } catch(e){}
  }
  $("panel").addEventListener("click", e => {
    const btn = e.target.closest("button[data-act]"); if (!btn) return;
    const id = btn.closest("li")?.dataset.id; if (!id) return;
    const act = btn.dataset.act;
    if (act === "done") panelAction(`/api/todos/${id}/complete`, "POST");
    if (act === "del") panelAction(`/api/todos/${id}`, "DELETE");
    if (act === "cancel") panelAction(`/api/timers/${id}`, "DELETE");
    if (act === "forget") panelAction(`/api/memory/${id}`, "DELETE");
  });
  $("panelToggle").onclick = () => document.body.classList.toggle("panel-open");
  $("panelClose").onclick = () => document.body.classList.remove("panel-open");
  fetch("/api/state").then(r => r.json()).then(renderState).catch(() => {});

  // countdowns tick every second; due timers are checked every 5 seconds
  setInterval(() => document.querySelectorAll("#timerList .left[data-due]").forEach(el =>
    el.textContent = fmtLeft(parseFloat(el.dataset.due) - Date.now()/1000)), 1000);
  setInterval(async () => {
    if (!persona) return;
    try {
      const j = await (await fetch("/api/timers/due?persona=" + persona.id)).json();
      if (j.state) renderState(j.state);
      for (const d of j.due){
        if (recorder) stopListening(false);
        const row = holder(add("ai", d.text)); row.classList.add("alarm");
        queueSpeech(d.text, turnId);
        if (document.hidden && window.Notification?.permission === "granted") new Notification(persona.name, {body: d.text});
      }
    } catch(e){}
  }, 5000);
  if (window.Notification && Notification.permission === "default")
    document.addEventListener("click", () => Notification.requestPermission().catch(() => {}), {once:true});

  // ---------- vision: camera, screen share, photos ----------
  const vision = { enabled:false, max:3, attached:[], stream:null, kind:"" };
  const MAX_SIDE = 1024;                                  // shrink before upload: faster, cheaper, under Groq limits
  function shrink(src, w, h){
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w*k); c.height = Math.round(h*k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  }
  async function attachFiles(files){
    if (!vision.enabled) return;
    for (const f of files){
      if (!f.type.startsWith("image/")) continue;
      if (vision.attached.length >= vision.max){ add("note", `You can show up to ${vision.max} images at a time.`); break; }
      try { const bmp = await createImageBitmap(f); vision.attached.push(shrink(bmp, bmp.width, bmp.height)); }
      catch(e){ add("note", "Couldn't open that image. Try a JPG or PNG."); }
    }
    renderEyes();
  }
  function renderEyes(){
    const t = $("thumbs"); t.innerHTML = "";
    vision.attached.forEach((u, i) => {
      const w = document.createElement("div"); w.className = "thumb";
      const im = new Image(); im.src = u; im.alt = "Attached image " + (i+1);
      const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label","Remove image");
      x.onclick = () => { vision.attached.splice(i, 1); renderEyes(); };
      w.append(im, x); t.appendChild(w);
    });
    const live = !!vision.stream;
    $("live").hidden = !live;
    $("eyes").hidden = !live && !vision.attached.length;
    $("eyeBtn").classList.toggle("on", live);
    $("eyesHint").textContent = live
      ? `${persona?.name || "The cat"} sees a snapshot of your ${vision.kind} with each message.`
      : vision.attached.length ? "Sent with your next message." : "";
  }
  async function startLive(kind){
    stopLive();
    try {
      vision.stream = kind === "screen"
        ? await navigator.mediaDevices.getDisplayMedia({video:true, audio:false})
        : await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280}, height:{ideal:720}, facingMode:"user"}, audio:false});
    } catch(e){
      vision.stream = null;
      if (e.name !== "NotAllowedError" || kind === "camera")
        add("note", kind === "camera" ? "Couldn't open the camera. Allow camera access from the address bar and try again." : "Screen sharing was cancelled.");
      return renderEyes();
    }
    vision.kind = kind;
    $("liveVideo").srcObject = vision.stream;
    $("liveTag").textContent = kind === "camera" ? "Camera" : "Screen";
    vision.stream.getVideoTracks()[0].onended = stopLive;   // e.g. "Stop sharing" in the browser bar
    renderEyes();
  }
  function stopLive(){
    vision.stream?.getTracks().forEach(t => t.stop());
    vision.stream = null; vision.kind = ""; $("liveVideo").srcObject = null;
    renderEyes();
  }
  vision.collect = () => {                                 // called when a message is sent
    const images = [], v = $("liveVideo");
    let source = vision.attached.length ? "photo" : "";
    if (vision.stream && v.readyState >= 2 && v.videoWidth){ images.push(shrink(v, v.videoWidth, v.videoHeight)); source = vision.kind; }
    images.push(...vision.attached);
    vision.attached = []; renderEyes();
    return { images: images.slice(0, vision.max), source };
  };

  const eyeMenu = $("eyeMenu");
  const closeMenu = () => { eyeMenu.hidden = true; $("eyeBtn").setAttribute("aria-expanded","false"); };
  $("eyeBtn").onclick = e => {
    e.stopPropagation();
    eyeMenu.querySelector('[data-src="camera"]').textContent = vision.kind === "camera" ? "Turn camera off" : "Camera";
    eyeMenu.querySelector('[data-src="screen"]').textContent = vision.kind === "screen" ? "Stop sharing screen" : "Share screen";
    eyeMenu.hidden = !eyeMenu.hidden; $("eyeBtn").setAttribute("aria-expanded", String(!eyeMenu.hidden));
  };
  eyeMenu.addEventListener("click", e => {
    const src = e.target.closest("button")?.dataset.src; if (!src) return;
    closeMenu();
    if (src === "photo") return $("fileIn").click();
    if (vision.kind === src) stopLive(); else startLive(src);
  });
  document.addEventListener("click", e => { if (!e.target.closest(".eye-wrap")) closeMenu(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
  $("liveOff").onclick = stopLive;
  $("fileIn").onchange = e => { attachFiles(e.target.files); e.target.value = ""; };
  document.addEventListener("paste", e => {                // Ctrl+V a screenshot
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
    if (files.length && vision.enabled){ e.preventDefault(); attachFiles(files); }
  });
  document.addEventListener("dragover", e => { if (vision.enabled && e.dataTransfer?.types.includes("Files")){ e.preventDefault(); document.body.classList.add("dropping"); } });
  document.addEventListener("dragleave", e => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
  document.addEventListener("drop", e => {
    document.body.classList.remove("dropping");
    if (!vision.enabled || !e.dataTransfer?.files.length) return;
    e.preventDefault(); attachFiles(e.dataTransfer.files);
  });
})();
