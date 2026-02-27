/**
 * scrapeAmazon.js (rewritten)
 * - Designed for Home Assistant add-on / Alpine Linux
 * - Uses system Chromium + puppeteer-core
 */

require("dotenv").config();

const puppeteer = require("puppeteer-core");
const OTPAuth = require("otpauth");
const fs = require("fs");
const path = require("path");

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

function getBaseUrl(url) {
  // https://www.amazon.com/ap/signin?... -> https://www.amazon.com
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

async function detectCaptcha(page) {
  // common Amazon captcha patterns
  const selectors = [
    "input#captchacharacters",
    "form[action*='validateCaptcha' i]",
    "img[alt*='captcha' i]",
    "div.a-box.a-alert.a-alert-error:has-text('captcha')",
  ];

  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return true;
  }

  // Also check URL
  const url = page.url().toLowerCase();
  if (url.includes("validatecaptcha") || url.includes("captcha")) return true;

  return false;
}

async function gotoWithRetries(page, url, { tries = 3, waitUntil = "domcontentloaded", timeout = 120000 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(1500 * i);
    }
  }
  throw lastErr;
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
    // userDataDir can help keep session/cookies. Keep if you want persistence:
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

  // Timeouts: don't use timeout: 0 on Amazon
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(120000);

  try {
    // 1) Hit main domain first (some setups behave better)
    const base = getBaseUrl(SIGNIN_URL);
    await gotoWithRetries(page, base, { tries: 2, waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(800);
    await safeScreenshot(page, "01-main");

    // 2) Go to sign-in
    await gotoWithRetries(page, SIGNIN_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await safeScreenshot(page, "02-signin");

    // CAPTCHA check early
    if (await detectCaptcha(page)) {
      await safeScreenshot(page, "captcha-detected");
      throw new Error("Amazon CAPTCHA detected on sign-in page. Aborting.");
    }

    // 3) Login flow (Amazon can show either combined email+pass or split screens)
    // Wait for either email or password field to exist
    await page.waitForSelector("#ap_email, input[name='email'], #ap_password, input[name='password']", { timeout: 60000 });

    // If email exists, fill it
    const hasEmail = (await page.$("#ap_email")) || (await page.$("input[name='email']"));
    if (hasEmail) {
      await page.type("#ap_email, input[name='email']", AMZ_LOGIN, { delay: 10 });
      await safeScreenshot(page, "03-email-filled");

      // If there's a continue button and no password yet, click continue
      const hasContinue = await page.$("#continue");
      const hasPasswordNow = await page.$("#ap_password, input[name='password']");
      if (hasContinue && !hasPasswordNow) {
        await page.click("#continue");
        await page.waitForTimeout(800);
      }
    }

    // Now wait for password field
    await page.waitForSelector("#ap_password, input[name='password']", { timeout: 60000 });
    await page.type("#ap_password, input[name='password']", AMZ_PASS, { delay: 10 });
    await safeScreenshot(page, "04-password-filled");

    // Click sign-in
    const signInBtn = await page.$("#signInSubmit, input#signInSubmit");
    if (!signInBtn) {
      await safeScreenshot(page, "signin-button-missing");
      throw new Error("Could not find sign-in submit button.");
    }

    await page.click("#signInSubmit, input#signInSubmit");

    // Let the page settle
    await page.waitForTimeout(1500);

    // 4) Handle MFA OTP if present
    // Amazon uses #auth-mfa-otpcode often
    const otpField = await page.$("#auth-mfa-otpcode");
    if (otpField) {
      if (!AMZ_SECRET) {
        await safeScreenshot(page, "mfa-no-secret");
        throw new Error("MFA required but AMZ_SECRET is missing.");
      }

      // Generate OTP only now (fresh)
      const totp = buildTotp(AMZ_SECRET, AMZ_LOGIN);
      const token = totp.generate();

      await page.type("#auth-mfa-otpcode", token, { delay: 10 });
      await safeScreenshot(page, "05-mfa-filled");

      const otpSubmit = await page.$("#auth-signin-button");
      if (!otpSubmit) {
        await safeScreenshot(page, "mfa-submit-missing");
        throw new Error("Could not find MFA submit button.");
      }

      await page.click("#auth-signin-button");
      await page.waitForTimeout(1500);
    }

    // CAPTCHA check after login click
    if (await detectCaptcha(page)) {
      await safeScreenshot(page, "captcha-after-login");
      throw new Error("Amazon CAPTCHA detected after login. Aborting.");
    }

    // 5) Go to shopping list
    await gotoWithRetries(page, LIST_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await safeScreenshot(page, "06-list-page");

    // Wait for list container
    await page.waitForSelector(".virtual-list", { timeout: 60000 });

    // Give it a moment to populate items
    await page.waitForTimeout(1500);
    await safeScreenshot(page, "07-list-loaded");

    // 6) Extract items
    const itemTitles = await page.$$eval(".virtual-list .item-title", (items) =>
      items.map((item) => (item.textContent || "").trim()).filter(Boolean)
    );

    const jsonFormattedItems = JSON.stringify(itemTitles, null, 2);

    if (LOG_LEVEL) {
      console.log(jsonFormattedItems);
    }

    // 7) Optional delete after download
    if (DELETE_AFTER_DOWNLOAD) {
      // NOTE: This is best-effort. Amazon may require confirmation dialogs depending on UI changes.
      await page.$$eval(".item-actions-2 button", (buttons) => buttons.forEach((b) => b.click()));
      await page.waitForTimeout(1000);
      await safeScreenshot(page, "08-after-delete-clicks");
    }

    // 8) Save output
    const outputDir = ".";
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "list_of_items.json"), jsonFormattedItems, "utf8");
  } catch (err) {
    // Always capture a last screenshot if possible
    try {
      await safeScreenshot(page, "error");
    } catch (_) {}

    console.error("Scrape failed:", err?.message || err);
    // rethrow so HA logs show failure
    throw err;
  } finally {
    await browser.close();
  }
})();
