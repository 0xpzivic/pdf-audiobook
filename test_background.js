const { chromium } = require("playwright");

const BASE = "http://localhost:8765";
const PDF = "/tmp/test_book.pdf";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const logs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => logs.push(m.text()));

  await page.goto(BASE + "/index.html", { waitUntil: "networkidle" });
  await page.setInputFiles("#file-input", PDF);
  await page.waitForSelector("#player-screen:not(.hidden)", { timeout: 20000 });
  await page.waitForTimeout(500);

  // Toggle to background mode
  await page.click("#mode-btn");
  await page.waitForTimeout(500);
  const modeLabel = await page.textContent("#mode-label");
  console.log("Mode label:", modeLabel);
  if (modeLabel !== "Background voice") throw new Error("Did not switch to background mode");

  // Toggle back to natural mode
  await page.click("#mode-btn");
  await page.waitForTimeout(300);
  const naturalLabel = await page.textContent("#mode-label");
  if (naturalLabel !== "Natural voice") throw new Error("Did not switch back to natural mode");

  if (errors.length) {
    console.log("ERRORS:", errors);
    console.log("LOGS:", logs);
    process.exit(1);
  }
  console.log("Background mode toggle OK");
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
