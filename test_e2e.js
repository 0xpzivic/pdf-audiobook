const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:8765";
const PDF = "/tmp/test_book.pdf";

// Mock speechSynthesis so TTS advancement works in headless Chromium.
const MOCK_TTS = `
(function(){
  var voices = [
    {name:"Samantha", lang:"en-US", default:true, localService:true, voiceURI:"Samantha"},
    {name:"Alex", lang:"en-US", default:false, localService:true, voiceURI:"Alex"}
  ];
  var current = null;
  var timer = null;
  var paused = false;
  var cancelled = false;
  var speakCalls = 0;
  window.__mockSpeakCalls = function(){ return speakCalls; };
  var mock = {
    paused: false,
    onvoiceschanged: null,
    getVoices: function(){ return voices.slice(); },
    speak: function(u){
      speakCalls++;
      console.log("MOCK speak called, text=", (u&&u.text||"").slice(0,20));
      cancelled = false; paused = false; mock.paused = false;
      current = u;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function(){
        console.log("MOCK timer firing, cancelled=", cancelled, "hasOnend=", !!(u&&u.onend));
        if (!cancelled && u && typeof u.onend === "function") u.onend();
      }, 30);
    },
    cancel: function(){ cancelled = true; if(timer){clearTimeout(timer);timer=null;} current=null; },
    pause: function(){ paused = true; mock.paused = true; if(timer){clearTimeout(timer);timer=null;} },
    resume: function(){ paused = false; mock.paused = false; if(current && current.onend){ timer=setTimeout(function(){ if(!cancelled&&current&&current.onend)current.onend(); },30);} }
  };
  try { Object.defineProperty(window, "speechSynthesis", { configurable:true, get:function(){return mock;} }); console.log("MOCK installed on window"); }
  catch(e){ try { Object.defineProperty(Window.prototype, "speechSynthesis", { configurable:true, get:function(){return mock;} }); console.log("MOCK installed on prototype"); } catch(e2){ console.log("MOCK install FAILED"); } }
  // Also mock SpeechSynthesisUtterance so assigning .voice with a plain object doesn't throw.
  function MockUtterance(text){ this.text = text||""; this.lang=""; this.voice=null; this.rate=1; this.pitch=1; this.volume=1; this.onend=null; this.onerror=null; this.onstart=null; this.onpause=null; this.onresume=null; this.onboundary=null; this.onmark=null; }
  try { Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable:true, value: MockUtterance }); } catch(e){}
  setTimeout(function(){ if(mock.onvoiceschanged) mock.onvoiceschanged(); }, 0);
})();
`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const errors = [];
  const logs = [];
  page.on("console", (m) => { logs.push("[" + m.type() + "] " + m.text()); if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => { logs.push("[pageerror] " + e.message); errors.push("PAGEERROR: " + e.message); });

  await page.addInitScript(MOCK_TTS);
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });

  // 1. Upload screen visible
  await page.waitForSelector("#upload-screen:not(.hidden)", { timeout: 5000 });
  console.log("PASS: upload screen visible");

  // 2. Upload PDF
  await page.setInputFiles("#file-input", PDF);
  await page.waitForSelector("#player-screen:not(.hidden)", { timeout: 20000 });
  console.log("PASS: player screen shown after upload");

  // 3. Segments extracted
  await page.waitForFunction(() => {
    const el = document.querySelector(".reading-view .sent.current");
    return el && el.textContent.trim().length > 0;
  }, { timeout: 10000 });
  const curText = await page.textContent(".reading-view .sent.current");
  const posLabel = await page.textContent("#pos-label");
  console.log("PASS: extracted text. first sentence:", JSON.stringify(curText.slice(0, 50)));
  console.log("     position label:", posLabel);

  const scrubberMax = parseInt(await page.getAttribute("#scrubber", "max"), 10);
  if (scrubberMax <= 0) throw new Error("FAIL: scrubber max should be > 0, got " + scrubberMax);
  console.log("PASS: scrubber max =", scrubberMax);

  // 4. Next button advances
  const beforeIdx = parseInt(await page.evaluate(() => document.getElementById("scrubber").value), 10);
  await page.click("#next-btn");
  await page.waitForTimeout(80);
  const afterNext = parseInt(await page.evaluate(() => document.getElementById("scrubber").value), 10);
  if (afterNext !== beforeIdx + 1) throw new Error(`FAIL: next did not advance (${beforeIdx} -> ${afterNext})`);
  console.log("PASS: next advances", beforeIdx, "->", afterNext);

  // 5. Prev button goes back
  await page.click("#prev-btn");
  await page.waitForTimeout(80);
  const afterPrev = parseInt(await page.evaluate(() => document.getElementById("scrubber").value), 10);
  if (afterPrev !== beforeIdx) throw new Error(`FAIL: prev did not go back (${afterNext} -> ${afterPrev})`);
  console.log("PASS: prev goes back", afterNext, "->", afterPrev);

  // 6. Rate up
  await page.click("#rate-up");
  await page.waitForTimeout(50);
  let rate = await page.textContent("#rate-val");
  if (rate !== "1.1×") throw new Error("FAIL: rate up wrong, got " + rate);
  console.log("PASS: rate up ->", rate);
  // back to 1.0
  await page.click("#rate-down");
  await page.waitForTimeout(50);

  // 7. Voice toggle
  const voiceBefore = await page.textContent("#voice-name");
  await page.click("#voice-btn");
  await page.waitForTimeout(50);
  const voiceAfter = await page.textContent("#voice-name");
  if (voiceBefore === voiceAfter) throw new Error("FAIL: voice did not toggle");
  console.log("PASS: voice toggles:", voiceBefore, "->", voiceAfter);
  // toggle back
  await page.click("#voice-btn");
  await page.waitForTimeout(50);

  // 8. Play -> advances automatically via mock onend
  await page.click("#play-btn");
  await page.waitForTimeout(200);
  const playState = await page.evaluate(() => document.getElementById("pause-icon").classList.contains("hidden") ? "play" : "pause");
  if (playState !== "pause") throw new Error("FAIL: play button did not switch to pause icon");
  console.log("PASS: play shows pause icon (speaking)");
  // let it advance a few sentences (mock fires onend after 30ms each)
  await page.waitForTimeout(100);
  const playingIdx = parseInt(await page.evaluate(() => document.getElementById("scrubber").value), 10);
  if (playingIdx <= afterPrev) {
    console.log("DEBUG console logs:\n" + logs.join("\n"));
    throw new Error("FAIL: did not auto-advance while playing (idx=" + playingIdx + ")");
  }
  console.log("PASS: auto-advanced to", playingIdx);

  // 9. Pause (while still playing, before book ends)
  await page.click("#play-btn");
  await page.waitForTimeout(50);
  const pausedState = await page.evaluate(() => document.getElementById("play-icon").classList.contains("hidden") ? "pause" : "play");
  if (pausedState !== "play") throw new Error("FAIL: pause did not switch back to play icon");
  console.log("PASS: pause switches to play icon");
  // stop the playback chain for clean state
  await page.click("#next-btn");
  await page.waitForTimeout(50);

  // 10. Persistence: reload, position restored
  const idxBeforeReload = parseInt(await page.evaluate(() => document.getElementById("scrubber").value), 10);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#player-screen:not(.hidden)", { timeout: 10000 });
  await page.waitForTimeout(300);
  const idxAfterReload = parseInt(await page.evaluate(() => document.getElementById("scrubber").value), 10);
  if (idxAfterReload !== idxBeforeReload)
    throw new Error(`FAIL: position not restored (${idxBeforeReload} -> ${idxAfterReload})`);
  console.log("PASS: position restored after reload:", idxAfterReload);

  // 11. Sleep timer popup opens and closes
  await page.click("#timer-btn");
  await page.waitForTimeout(100);
  const popupVisible = await page.evaluate(() => !document.getElementById("timer-popup").classList.contains("hidden"));
  if (!popupVisible) throw new Error("FAIL: timer popup did not open");
  console.log("PASS: sleep timer popup opens");

  // 12. Set a sleep timer (5 min) -> label updates
  await page.click('.timer-opt[data-min="5"]');
  await page.waitForTimeout(100);
  const timerLabel = await page.textContent("#timer-label");
  if (!timerLabel.includes("⏱")) throw new Error("FAIL: timer label not showing countdown, got: " + timerLabel);
  console.log("PASS: sleep timer set, label:", timerLabel);

  // 13. Turn off sleep timer
  await page.click("#timer-btn");
  await page.waitForTimeout(100);
  await page.click('.timer-opt[data-min="0"]');
  await page.waitForTimeout(100);
  const timerLabelOff = await page.textContent("#timer-label");
  if (timerLabelOff !== "Sleep timer") throw new Error("FAIL: timer not turned off, got: " + timerLabelOff);
  console.log("PASS: sleep timer turned off");

  // 14. No console errors
  if (errors.length) {
    console.log("FAIL: console errors:\n" + errors.join("\n"));
    process.exit(1);
  }
  console.log("PASS: no console errors");

  await browser.close();
  console.log("\nALL TESTS PASSED");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
