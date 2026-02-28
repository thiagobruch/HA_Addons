/**
 * scrapeAmazon.js
 * - Home Assistant add-on / Alpine Linux friendly
 * - Uses system Chromium + puppeteer-core
 * - CAPTCHA detection: Puppeteer-compatible (no :has-text)
 */

require("dotenv").config();

const puppeteer = require("puppeteer-core");
const OTPAuth = require("otpauth");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- helpers ----------
function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function env(name, required = true) {
  const v = process.env[name];
  if (required && (v === undefined || v === null || `${v}`.trim() === "")) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

async function safeScreenshot(page, label) {
  try {
    const logLevel = `${env("log_level", false) || ""}`.toLowerCase() === "true";
    if (!logLevel) return;
    const filename = `www/${getTimestamp()}-${label}.png`;
    await page.screenshot({ path: filename, fullPage: true });
  } catch (_) {
    // don't fail the run because screenshots failed
  }
}

async function safeHtmlDump(page, label) {
  try {
    const logLevel = `${env("log_level", false) || ""}`.toLowerCase() === "true";
    if (!logLevel) return;
    const filename = `www/${getTimestamp()}-${label}.html`;
    const html = await page.content();
    fs.writeFileSync(filename, html, "utf8");
  } catch (_) {
    // ignore
  }
}

function getBaseUrl(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function buildTotp(secretBase32, label) {
  return new OTPAuth.TOTP({
    issuer: "Amazon",
    label: label || "Amazon OTP",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/**
 * CAPTCHA detection (Puppeteer-safe):
 * - URL patterns (validatecaptcha, /captcha)
 * - DOM selectors commonly used on Amazon captcha pages
 * - Text sniffing in body innerText (no :has-text)
 */
async function detectCaptcha(page) {
  // 1) URL-based detection
  try {
    const url = (page.url() || "").toLowerCase();
    if (url.includes("validatecaptcha") || url.includes("/captcha")) return true;
  } catch (_) {}

  // 2) DOM-based detection
  const selectors = [
    "#captchacharacters",
    "input#captchacharacters",
    "form[action*='validateCaptcha' i]",
    "img[alt*='captcha' i]",
    "input[name='cvf_captcha_input']",
    "input[name='captcha']",
  ];

  for (const sel of selectors) {
    try {
      if (await page.$(sel)) return true;
    } catch (_) {
      // if a selector ever throws, ignore and continue
    }
  }

  // 3) Text-based detection
  try {
    const text = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
    if (text.includes("enter the characters you see below")) return true;
    if (text.includes("sorry, we just need to make sure you're not a robot")) return true;
    if (text.includes("type the characters")) return true;
  } catch (_) {}

  return false;
}

async function gotoWithRetries(
  page,
  url,
  { tries = 3, waitUntil = "domcontentloaded", timeout = 120000 } = {}
) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * i);
    }
  }
  throw lastErr;
}

async function assertNoCaptcha(page, labelForArtifacts) {
  const isCaptcha = await detectCaptcha(page);
  if (!isCaptcha) return;

  await safeScreenshot(page, `${labelForArtifacts}-captcha`);
  await safeHtmlDump(page, `${labelForArtifacts}-captcha`);
  throw new Error("Amazon CAPTCHA detected. Aborting.");
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return sel;
      }
    } catch (_) {}
  }
  return null;
}

async function pressEnterOnPassword(page) {
  try {
    const pw = await page.$("#ap_password, input[name='password']");
    if (pw) {
      await pw.focus();
      await page.keyboard.press("Enter");
      return true;
    }
  } catch (_) {}
  return false;
}
// ---------- main ----------
(async () => {
  const AMZ_SECRET = env("AMZ_SECRET", false); // optional if you don't always hit MFA
  const AMZ_LOGIN = env("AMZ_LOGIN");
  const AMZ_PASS = env("AMZ_PASS");
  const DELETE_AFTER_DOWNLOAD = `${env("DELETE_AFTER_DOWNLOAD", false) || ""}`.toLowerCase() === "true";
  const LOG_LEVEL = `${env("log_level", false) || ""}`.toLowerCase() === "true";
  const SIGNIN_URL = env("Amazon_Sign_in_URL");
  const LIST_URL = env("Amazon_Shopping_List_Page");

  const chromiumPath = env("CHROMIUM_PATH", false) || "/usr/bin/chromium";

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromiumPath,
    userDataDir: "./tmp",
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-features=site-per-process",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(120000);

  try {
    // 1) Main domain
    const base = getBaseUrl(SIGNIN_URL);
    await gotoWithRetries(page, base, { tries: 2, waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(800);
    await safeScreenshot(page, "01-main");

    // 2) Sign-in page
    await gotoWithRetries(page, SIGNIN_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await safeScreenshot(page, "02-signin");
    await assertNoCaptcha(page, "02-signin");

    // 3) Login flow (combined or split screens)
    await page.waitForSelector("#ap_email, input[name='email'], #ap_password, input[name='password']", { timeout: 60000 });

    // email screen?
// --- EMAIL STEP (robust) ---
const emailSel = "#ap_email, input[name='email']";
const continueSelectors = [
  "#Continue",                     // common
  "input#Continue",                // sometimes input
  "span#Continue input",           // amazon wraps input inside span
  "input[type='submit']#Continue",
  "input[type='submit'][aria-labelledby*='continue' i]",
  "input[type='submit'][value*='continue' i]",
  "button#Continue",
  "button[type='submit']",
];

const emailEl = await page.$(emailSel);
if (emailEl) {
  // Clear properly
  await page.focus(emailSel);
  await page.click(emailSel, { clickCount: 3 });
  await page.keyboard.press("Backspace");

  // Type
  await page.type(emailSel, AMZ_LOGIN, { delay: 20 });

  // Trigger Amazon’s JS (input/change/blur)
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }, emailSel);

  await safeScreenshot(page, "03-email-filled");

  // If password already visible, skip continue
  const passwordVisible = await page.$("#ap_password, input[name='password']");
  if (!passwordVisible) {
    // Wait for continue to exist (Amazon can render late)
    try {
      await page.waitForSelector(
        "#Continue, input#Continue, span#Continue input, button#Continue",
        { timeout: 15000 }
      );
    } catch (_) {
      // keep going; we'll try click fallbacks
    }

    // Try clicking continue using fallbacks
    const clickedSel = await clickFirst(page, continueSelectors);

    if (!clickedSel) {
      // Fallback: press Enter in email field
      await page.focus(emailSel);
      await page.keyboard.press("Enter");
    }

    await sleep(1200);
    await safeScreenshot(page, "03-after-continue");
    await assertNoCaptcha(page, "03-after-continue");
  }
}

    // password screen
    await page.waitForSelector("#ap_password, input[name='password']", { timeout: 60000 });
    await page.type("#ap_password, input[name='password']", AMZ_PASS, { delay: 10 });
    await safeScreenshot(page, "04-password-filled");

    // submit sign-in
const clicked = await clickFirst(page, [
  "#signInSubmit",
  "input#signInSubmit",
  "button#signInSubmit",
  "button[type='submit']",
  "input[type='submit']",
  "form[name='signIn'] input[type='submit']",
  "form[action*='signin' i] input[type='submit']",
]);

if (!clicked) {
  // Fallback: try Enter on password field
  const didEnter = await pressEnterOnPassword(page);

  if (!didEnter) {
    await safeScreenshot(page, "signin-submit-missing");
    await safeHtmlDump(page, "signin-submit-missing");
    throw new Error("Could not find sign-in submit button (and Enter fallback failed).");
  }
}

await sleep(1500);
await safeScreenshot(page, "04-after-signin-submit");
await assertNoCaptcha(page, "04-after-signin-submit");
    await sleep(1500);
    await safeScreenshot(page, "04-after-signin-click");
    await assertNoCaptcha(page, "04-after-signin-click");

    // 4) MFA OTP if present
    const otpField = await page.$("#auth-mfa-otpcode");
    if (otpField) {
      if (!AMZ_SECRET) {
        await safeScreenshot(page, "mfa-no-secret");
        await safeHtmlDump(page, "mfa-no-secret");
        throw new Error("MFA required but AMZ_SECRET is missing.");
      }

      const totp = buildTotp(AMZ_SECRET, AMZ_LOGIN);
      const token = totp.generate();

      await page.type("#auth-mfa-otpcode", token, { delay: 10 });
      await safeScreenshot(page, "05-mfa-filled");

      const otpSubmit = await page.$("#auth-signin-button");
      if (!otpSubmit) {
        await safeScreenshot(page, "mfa-submit-missing");
        await safeHtmlDump(page, "mfa-submit-missing");
        throw new Error("Could not find MFA submit button.");
      }

      await page.click("#auth-signin-button");
      await sleep(1500);
      await safeScreenshot(page, "05-after-mfa-submit");
      await assertNoCaptcha(page, "05-after-mfa-submit");
    }

    // 5) Go to shopping list page
    await gotoWithRetries(page, LIST_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await safeScreenshot(page, "06-list-page");
    await assertNoCaptcha(page, "06-list-page");

    await page.waitForSelector(".virtual-list", { timeout: 60000 });
    await sleep(1500);
    await safeScreenshot(page, "07-list-loaded");

    // 6) Extract items
    const itemTitles = await page.$$eval(".virtual-list .item-title", (items) =>
      items
        .map((item) => (item.textContent || "").trim())
        .filter(Boolean)
    );

    const jsonFormattedItems = JSON.stringify(itemTitles, null, 2);
    if (LOG_LEVEL) console.log(jsonFormattedItems);

    // 7) Optional delete after download
    if (DELETE_AFTER_DOWNLOAD) {
      // best-effort click; Amazon UI can change
      await page.$$eval(".item-actions-2 button", (buttons) => buttons.forEach((b) => b.click()));
      await sleep(1000);
      await safeScreenshot(page, "08-after-delete-clicks");
    }

    // 8) Save output
    const outputDir = ".";
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "list_of_items.json"), jsonFormattedItems, "utf8");
  } catch (err) {
    try {
      await safeScreenshot(page, "error");
      await safeHtmlDump(page, "error");
    } catch (_) {}

    console.error("Scrape failed:", err?.message || err);
    throw err;
  } finally {
    await browser.close();
  }
})();
