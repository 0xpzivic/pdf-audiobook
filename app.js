"use strict";

/* ============================================================
   PDF Audiobook - client-side PWA
   - Extracts text from a PDF with pdf.js
   - Reads it aloud with the Web Speech API (built-in iOS voices)
   - Remembers position, speed and voice across restarts (IndexedDB)
   ============================================================ */

const PDFJS_VER = "3.11.174";
const PDFJS_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.js`;
const PDFJS_WORKER = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.js`;

const DB_NAME = "pdf-audiobook";
const DB_VERSION = 1;
const STATE_KEY = "current";

// ----- App state -----
const state = {
  segments: [],      // [{ text, page }]
  segIndex: 0,       // current sentence index
  rate: 1.0,
  voiceName: null,
  voices: [],        // available en voices
  voiceOptions: [],  // the chosen voices (up to 3)
  fileName: null,
  numPages: 0,
  isPlaying: false,
  audioKeepAlive: null, // AudioContext for lock-screen keep-alive
  sleepTimer: null,     // setTimeout id for sleep timer
  sleepTimerEnd: null,  // timestamp when timer fires
};

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const uploadScreen = $("upload-screen");
const playerScreen = $("player-screen");
const fileInput = $("file-input");
const uploadStatus = $("upload-status");

const bookTitleEl = $("book-title");
const bookMetaEl = $("book-meta");
const readingView = $("reading-view");
const scrubber = $("scrubber");
const posLabel = $("pos-label");
const pageLabel = $("page-label");
const playBtn = $("play-btn");
const playIcon = $("play-icon");
const pauseIcon = $("pause-icon");
const prevBtn = $("prev-btn");
const nextBtn = $("next-btn");
const rateDown = $("rate-down");
const rateUp = $("rate-up");
const rateVal = $("rate-val");
const voiceBtn = $("voice-btn");
const voiceName = $("voice-name");
const backBtn = $("back-btn");
const removeBtn = $("remove-btn");
const timerBtn = $("timer-btn");
const timerLabel = $("timer-label");
const timerPopup = $("timer-popup");
const timerClose = $("timer-close");

/* ============================================================
   IndexedDB helpers
   ============================================================ */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("book")) {
        db.createObjectStore("book", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("state")) {
        db.createObjectStore("state", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store, value) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbGet(store, key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const r = tx.objectStore(store).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      })
  );
}

function idbClear(store) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function saveBook(book) {
  return idbPut("book", { id: STATE_KEY, ...book });
}
function loadBook() {
  return idbGet("book", STATE_KEY);
}
function saveAppState() {
  return idbPut("state", {
    id: STATE_KEY,
    segIndex: state.segIndex,
    rate: state.rate,
    voiceName: state.voiceName,
    savedAt: Date.now(),
  });
}
function loadAppState() {
  return idbGet("state", STATE_KEY);
}

/* ============================================================
   Text extraction & segmentation
   ============================================================ */
function cleanText(raw) {
  let t = raw.replace(/\r/g, "\n");
  // Rejoin words hyphenated across line breaks: "exam-\nple" -> "example"
  t = t.replace(/([a-zà-ÿ])-\s+([a-zà-ÿ])/g, "$1$2");
  // Newlines -> spaces
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function splitSentences(text) {
  // Capture sentences ending in . ! ? possibly followed by quotes/brackets.
  const re = /[^.!?]+[.!?]+["'”’)\]]*[ \t]*/g;
  const out = [];
  let m;
  let rest = text;
  while ((m = re.exec(text)) !== null) {
    let s = m[0].trim();
    if (s) out.push(s);
    rest = text.slice(re.lastIndex);
  }
  if (rest && rest.trim()) out.push(rest.trim());
  // Further split overly long chunks on commas/semicolons (iOS cuts long speech).
  const final = [];
  for (const s of out) {
    if (s.length <= 240) {
      final.push(s);
    } else {
      const parts = s.split(/(?<=[,;:])\s+/);
      let buf = "";
      for (const p of parts) {
        if ((buf + " " + p).trim().length > 240 && buf) {
          final.push(buf.trim());
          buf = p;
        } else {
          buf = (buf ? buf + " " : "") + p;
        }
      }
      if (buf.trim()) final.push(buf.trim());
    }
  }
  return final;
}

async function loadPdfjs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PDFJS_SRC;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load pdf.js (offline?). Reopen online once to cache it."));
    document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return window.pdfjsLib;
}

async function pdfToSegments(arrayBuffer) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const segments = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const raw = content.items.map((it) => it.str).join(" ");
    const cleaned = cleanText(raw);
    if (!cleaned) continue;
    for (const sentence of splitSentences(cleaned)) {
      segments.push({ text: sentence, page: p });
    }
  }
  return { segments, numPages: doc.numPages };
}

/* ============================================================
   Speech synthesis
   ============================================================ */
function refreshVoices() {
  const all = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  state.voices = all.filter((v) => /^en/i.test(v.lang));
  // Pick preferred voices in order of naturalness:
  // 1. Samantha (female, very natural)
  // 2. Alex (male, natural)
  // 3. Ava (iOS 17+ enhanced natural female) — falls back to Daniel, then Karen
  const find = (name) => state.voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
  const preferred = [];
  const sam = find("Samantha");
  if (sam) preferred.push(sam);
  const alex = find("Alex");
  if (alex) preferred.push(alex);
  // Third voice: try Ava (premium), then Daniel (British male), then Karen (Australian female)
  const third = find("Ava") || find("Daniel") || find("Karen") || find("Tom") || find("Zoe");
  if (third) preferred.push(third);
  // Fill up to 3 with any other en voices if we couldn't find preferred ones.
  for (const v of state.voices) {
    if (preferred.length >= 3) break;
    if (!preferred.includes(v)) preferred.push(v);
  }
  state.voiceOptions = preferred.slice(0, 3);
  // Validate current voiceName still exists.
  if (state.voiceName && !all.some((v) => v.name === state.voiceName)) {
    state.voiceName = state.voiceOptions[0] ? state.voiceOptions[0].name : null;
  }
  if (!state.voiceName && state.voiceOptions[0]) {
    state.voiceName = state.voiceOptions[0].name;
  }
  renderVoice();
}

function currentVoice() {
  return state.voices.find((v) => v.name === state.voiceName) || state.voiceOptions[0] || null;
}

function speakSegment(index) {
  if (!window.speechSynthesis) return;
  if (index < 0 || index >= state.segments.length) {
    stopPlayback();
    return;
  }
  // Save position BEFORE speaking so if iOS kills the app mid-sentence,
  // we resume at this sentence (re-reading it) rather than skipping it.
  state.segIndex = index;
  saveAppState();
  renderPosition();
  const seg = state.segments[index];
  const u = new SpeechSynthesisUtterance(seg.text);
  const v = currentVoice();
  if (v) u.voice = v;
  u.lang = v ? v.lang : "en-US";
  u.rate = state.rate;
  u.onend = () => {
    // Only advance if we're still on this segment (not cancelled by user).
    if (!state.isPlaying) return;
    state.segIndex = index + 1;
    saveAppState();
    if (state.segIndex < state.segments.length) {
      renderPosition();
      speakSegment(state.segIndex);
    } else {
      // Finished the book.
      state.isPlaying = false;
      renderPlayButton();
      renderPosition();
      stopAudioKeepAlive();
    }
  };
  u.onerror = () => {
    if (!state.isPlaying) return;
    state.segIndex = index + 1;
    saveAppState();
    if (state.segIndex < state.segments.length) {
      renderPosition();
      speakSegment(state.segIndex);
    } else {
      state.isPlaying = false;
      renderPlayButton();
      stopAudioKeepAlive();
    }
  };
  window.speechSynthesis.speak(u);
}

function play() {
  if (state.segments.length === 0) return;
  // Resume from end -> restart at beginning.
  if (state.segIndex >= state.segments.length) state.segIndex = 0;
  // If paused mid-utterance, resume.
  if (window.speechSynthesis.paused) {
    window.speechSynthesis.resume();
    state.isPlaying = true;
    renderPlayButton();
    startAudioKeepAlive();
    return;
  }
  state.isPlaying = true;
  renderPlayButton();
  startAudioKeepAlive();
  speakSegment(state.segIndex);
}

function pause() {
  if (!window.speechSynthesis) return;
  state.isPlaying = false;
  try { window.speechSynthesis.pause(); } catch (e) {}
  renderPlayButton();
  saveAppState();
  stopAudioKeepAlive();
}

function stopPlayback() {
  state.isPlaying = false;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  renderPlayButton();
  stopAudioKeepAlive();
}

/* ============================================================
   Audio keep-alive for lock-screen / background playback.
   iOS suspends SpeechSynthesis when the app is backgrounded.
   Playing a silent audio loop keeps the audio session alive,
   which can help TTS continue on some iOS versions.
   This is a best-effort hack — iOS may still stop TTS on lock.
   ============================================================ */
function startAudioKeepAlive() {
  if (state.audioKeepAlive) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    // Create a near-silent oscillator to keep the audio session active.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001; // effectively silent
    osc.frequency.value = 1;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    state.audioKeepAlive = ctx;
    // Set up Media Session so lock screen shows playback controls.
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.fileName ? state.fileName.replace(/\.pdf$/i, "") : "Audiobook",
        artist: "PDF Audiobook",
        album: "PDF Audiobook",
      });
      navigator.mediaSession.setActionHandler("play", () => play());
      navigator.mediaSession.setActionHandler("pause", () => pause());
      navigator.mediaSession.setActionHandler("previoustrack", () => jump(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => jump(1));
      navigator.mediaSession.playbackState = "playing";
    }
  } catch (e) {
    console.warn("Audio keep-alive failed:", e);
  }
}

function stopAudioKeepAlive() {
  if (!state.audioKeepAlive) return;
  try {
    state.audioKeepAlive.close();
  } catch (e) {}
  state.audioKeepAlive = null;
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = "paused";
  }
}

function jump(delta) {
  const wasPlaying = state.isPlaying;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  state.isPlaying = false;
  state.segIndex = Math.max(0, Math.min(state.segments.length - 1, state.segIndex + delta));
  saveAppState();
  renderPosition();
  if (wasPlaying) {
    state.isPlaying = true;
    renderPlayButton();
    speakSegment(state.segIndex);
  }
  updateMediaSession();
}

function scrubTo(index) {
  const wasPlaying = state.isPlaying;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  state.isPlaying = false;
  state.segIndex = Math.max(0, Math.min(state.segments.length - 1, index));
  saveAppState();
  renderPosition();
  if (wasPlaying) {
    state.isPlaying = true;
    renderPlayButton();
    speakSegment(state.segIndex);
  }
  updateMediaSession();
}

function updateMediaSession() {
  if ("mediaSession" in navigator && state.isPlaying) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: state.fileName ? state.fileName.replace(/\.pdf$/i, "") : "Audiobook",
      artist: "PDF Audiobook",
      album: "PDF Audiobook",
    });
  }
}

/* ============================================================
   Sleep timer
   ============================================================ */
function setSleepTimer(minutes) {
  clearSleepTimer();
  if (minutes <= 0) {
    renderTimerLabel();
    return;
  }
  state.sleepTimerEnd = Date.now() + minutes * 60 * 1000;
  state.sleepTimer = setTimeout(() => {
    stopPlayback();
    clearSleepTimer();
  }, minutes * 60 * 1000);
  renderTimerLabel();
}

function clearSleepTimer() {
  if (state.sleepTimer) {
    clearTimeout(state.sleepTimer);
    state.sleepTimer = null;
  }
  state.sleepTimerEnd = null;
  renderTimerLabel();
}

function renderTimerLabel() {
  if (!state.sleepTimerEnd) {
    timerLabel.textContent = "Sleep timer";
    timerLabel.classList.remove("active");
    return;
  }
  const remaining = Math.max(0, state.sleepTimerEnd - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  timerLabel.textContent = `⏱ ${mins}:${secs.toString().padStart(2, "0")}`;
  timerLabel.classList.add("active");
}

function openTimerPopup() {
  timerPopup.classList.remove("hidden");
  // Highlight active option
  const opts = timerPopup.querySelectorAll(".timer-opt");
  opts.forEach((o) => o.classList.remove("active"));
  if (state.sleepTimerEnd) {
    // No specific highlight since we use custom durations; just leave none active
  } else {
    opts[0].classList.add("active"); // "Off"
  }
}

function closeTimerPopup() {
  timerPopup.classList.add("hidden");
}

/* ============================================================
   Rendering
   ============================================================ */
function showUpload() {
  playerScreen.classList.add("hidden");
  uploadScreen.classList.remove("hidden");
}

function showPlayer() {
  uploadScreen.classList.add("hidden");
  playerScreen.classList.remove("hidden");
}

function renderPosition() {
  const n = state.segments.length;
  const i = state.segIndex;
  scrubber.max = Math.max(0, n - 1);
  scrubber.value = Math.min(i, Math.max(0, n - 1));
  posLabel.textContent = `${Math.min(i + 1, n)} / ${n}`;
  const cur = state.segments[i];
  pageLabel.textContent = cur ? `Page ${cur.page}` : "";

  // Build a flowing text view: show sentences around the current one,
  // with the current sentence highlighted. Page breaks are shown as markers.
  const CONTEXT = 4; // sentences before/after to show
  const start = Math.max(0, i - CONTEXT);
  const end = Math.min(n, i + CONTEXT + 1);
  let html = "";
  let lastPage = null;
  for (let j = start; j < end; j++) {
    const seg = state.segments[j];
    if (!seg) continue;
    // Show page break marker when crossing into a new page.
    if (seg.page !== lastPage && lastPage !== null) {
      html += `<span class="page-break">— Page ${seg.page} —</span> `;
    }
    lastPage = seg.page;
    let cls = "sent ";
    if (j < i) cls += "past";
    else if (j === i) cls += "current";
    else cls += "upcoming";
    html += `<span class="${cls}" data-idx="${j}">${escapeHtml(seg.text)} </span>`;
  }
  readingView.innerHTML = html;
  // Scroll the current sentence into view.
  const curEl = readingView.querySelector(".sent.current");
  if (curEl) curEl.scrollIntoView({ block: "center", behavior: "smooth" });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function renderPlayButton() {
  if (state.isPlaying) {
    playIcon.classList.add("hidden");
    pauseIcon.classList.remove("hidden");
    playBtn.setAttribute("aria-label", "Pause");
  } else {
    playIcon.classList.remove("hidden");
    pauseIcon.classList.add("hidden");
    playBtn.setAttribute("aria-label", "Play");
  }
}

function renderRate() {
  rateVal.textContent = state.rate.toFixed(1) + "×";
}

function renderVoice() {
  voiceName.textContent = state.voiceName || "Default voice";
}

function renderHeader() {
  bookTitleEl.textContent = state.fileName ? state.fileName.replace(/\.pdf$/i, "") : "Audiobook";
  const mins = Math.max(1, Math.round(state.segments.length * 6 / state.rate));
  bookMetaEl.textContent = `${state.numPages} pages · ${state.segments.length} sentences`;
}

/* ============================================================
   File handling
   ============================================================ */
async function handleFile(file) {
  if (!file) return;
  uploadStatus.textContent = "Reading PDF…";
  uploadStatus.classList.remove("error");
  try {
    const buf = await file.arrayBuffer();
    uploadStatus.textContent = "Extracting text…";
    const { segments, numPages } = await pdfToSegments(buf);
    if (segments.length === 0) {
      throw new Error("No readable text found. This PDF may be scanned images (no text layer).");
    }
    state.segments = segments;
    state.numPages = numPages;
    state.fileName = file.name;
    state.segIndex = 0;
    await saveBook({
      file: new Blob([buf], { type: "application/pdf" }),
      name: file.name,
      segments,
      numPages,
      savedAt: Date.now(),
    });
    await saveAppState();
    uploadStatus.textContent = "";
    renderHeader();
    renderPosition();
    renderRate();
    renderVoice();
    showPlayer();
  } catch (err) {
    console.error(err);
    uploadStatus.textContent = "Error: " + (err.message || err);
    uploadStatus.classList.add("error");
  }
}

async function restoreBook() {
  const book = await loadBook();
  const saved = await loadAppState();
  if (saved) {
    state.segIndex = saved.segIndex || 0;
    state.rate = saved.rate || 1.0;
    state.voiceName = saved.voiceName || null;
  }
  if (book && book.segments && book.segments.length) {
    state.segments = book.segments;
    state.numPages = book.numPages || 0;
    state.fileName = book.name;
    renderHeader();
    renderPosition();
    renderRate();
    renderVoice();
    showPlayer();
    return true;
  }
  return false;
}

async function removeBook() {
  if (!confirm("Remove the current book and its saved position?")) return;
  stopPlayback();
  try { await idbClear("book"); } catch (e) {}
  try { await idbClear("state"); } catch (e) {}
  state.segments = [];
  state.segIndex = 0;
  state.fileName = null;
  state.numPages = 0;
  showUpload();
  uploadStatus.textContent = "";
}

/* ============================================================
   Event wiring
   ============================================================ */
function wireEvents() {
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
    fileInput.value = "";
  });

  playBtn.addEventListener("click", () => {
    if (state.isPlaying) pause();
    else play();
  });
  prevBtn.addEventListener("click", () => jump(-1));
  nextBtn.addEventListener("click", () => jump(1));

  rateDown.addEventListener("click", () => {
    state.rate = Math.max(0.5, Math.round((state.rate - 0.1) * 10) / 10);
    renderRate();
    saveAppState();
    // Apply to current speech if speaking: restart current segment at new rate.
    if (state.isPlaying) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      speakSegment(state.segIndex);
    }
  });
  rateUp.addEventListener("click", () => {
    state.rate = Math.min(2.0, Math.round((state.rate + 0.1) * 10) / 10);
    renderRate();
    saveAppState();
    if (state.isPlaying) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      speakSegment(state.segIndex);
    }
  });

  voiceBtn.addEventListener("click", () => {
    if (state.voiceOptions.length === 0) return;
    const idx = state.voiceOptions.findIndex((v) => v.name === state.voiceName);
    const next = state.voiceOptions[(idx + 1) % state.voiceOptions.length];
    state.voiceName = next.name;
    renderVoice();
    saveAppState();
    if (state.isPlaying) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      speakSegment(state.segIndex);
    }
  });

  scrubber.addEventListener("input", (e) => {
    scrubTo(parseInt(e.target.value, 10));
  });

  backBtn.addEventListener("click", () => {
    stopPlayback();
    showUpload();
  });
  removeBtn.addEventListener("click", removeBook);

  // Sleep timer
  timerBtn.addEventListener("click", openTimerPopup);
  timerClose.addEventListener("click", closeTimerPopup);
  timerPopup.addEventListener("click", (e) => {
    if (e.target === timerPopup) closeTimerPopup();
  });
  timerPopup.querySelectorAll(".timer-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mins = parseInt(btn.dataset.min, 10);
      setSleepTimer(mins);
      closeTimerPopup();
    });
  });

  // Update timer label every second while active
  setInterval(() => {
    if (state.sleepTimerEnd) renderTimerLabel();
  }, 1000);

  // Persist position when the app is hidden or closed.
  // On iOS, the audio keep-alive may let TTS continue in background.
  // We save state aggressively so position is never lost.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveAppState();
    } else if (document.visibilityState === "visible") {
      // If we were playing and iOS killed TTS while hidden, update UI.
      if (state.isPlaying && window.speechSynthesis && !window.speechSynthesis.speaking) {
        state.isPlaying = false;
        renderPlayButton();
        stopAudioKeepAlive();
      }
      saveAppState();
    }
  });
  window.addEventListener("pagehide", () => {
    saveAppState();
  });

  // Voices load asynchronously on iOS.
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = refreshVoices;
    // Some browsers need a kick.
    refreshVoices();
    setTimeout(refreshVoices, 500);
    setTimeout(refreshVoices, 1500);
  }
}

/* ============================================================
   Init
   ============================================================ */
async function init() {
  wireEvents();
  refreshVoices();
  const restored = await restoreBook();
  if (!restored) showUpload();

  // Register service worker for offline support.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    });
  }
}

init();
