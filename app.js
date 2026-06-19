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
  voiceOptions: [],  // the 2 chosen voices
  fileName: null,
  numPages: 0,
  isPlaying: false,
  isLoadingVoices: false,
};

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const uploadScreen = $("upload-screen");
const playerScreen = $("player-screen");
const fileInput = $("file-input");
const uploadStatus = $("upload-status");

const bookTitleEl = $("book-title");
const bookMetaEl = $("book-meta");
const prevTextEl = $("prev-text");
const curTextEl = $("cur-text");
const nextTextEl = $("next-text");
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
  // Pick preferred voices: Samantha (female) + Alex (male).
  const find = (name) => state.voices.find((v) => v.name.toLowerCase() === name.toLowerCase());
  const preferred = [];
  const sam = find("Samantha");
  if (sam) preferred.push(sam);
  const alex = find("Alex");
  if (alex) preferred.push(alex);
  // Fill up to 2 with any other en voices.
  for (const v of state.voices) {
    if (preferred.length >= 2) break;
    if (!preferred.includes(v)) preferred.push(v);
  }
  state.voiceOptions = preferred.slice(0, 2);
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
    return;
  }
  state.isPlaying = true;
  renderPlayButton();
  speakSegment(state.segIndex);
}

function pause() {
  if (!window.speechSynthesis) return;
  state.isPlaying = false;
  try { window.speechSynthesis.pause(); } catch (e) {}
  renderPlayButton();
  saveAppState();
}

function stopPlayback() {
  state.isPlaying = false;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  renderPlayButton();
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
  if (cur) {
    curTextEl.textContent = cur.text;
    pageLabel.textContent = `Page ${cur.page}`;
  } else {
    curTextEl.textContent = "—";
    pageLabel.textContent = "";
  }
  prevTextEl.textContent = state.segments[i - 1] ? state.segments[i - 1].text : "";
  nextTextEl.textContent = state.segments[i + 1] ? state.segments[i + 1].text : "";
  // Keep current sentence in view.
  curTextEl.scrollIntoView({ block: "center", behavior: "smooth" });
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

  // Persist position when the app is hidden or closed (iOS pauses/cuts TTS).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (state.isPlaying) {
        state.isPlaying = false;
        try { window.speechSynthesis.pause(); } catch (e) {}
        renderPlayButton();
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
