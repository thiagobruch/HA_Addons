/**
 * scrapeAmazon.js (full rewrite with robust login state machine)
 * - Home Assistant add-on / Alpine friendly
 * - Uses system Chromium + puppeteer-core (no @puppeteer/browsers)
 * - Robust email -> continue -> password flow (prevents silently staying on email page)
 * - CAPTCHA detection (Puppeteer-safe; no :has-text)
 * - Writes screenshots + HTML to www/ when log_level=true
 */

require("dotenv").config();

const puppeteer = require("puppeteer-core");
const OTPAuth = require("otpauth");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------- helpers ----------------
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

function isTrue(v) {
  return `${v || ""}`.toLowerCase() === "true";
}

async function safeScreenshot(page, label) {
  try {
    if (!isTrue(env("log_level", false))) return;
    const filename = `www/${getTimestamp()}-${label}.png`;
    await page.screenshot({ path: filename, fullPage: true });
  } catch (_) {}
}

async function safeHtmlDump(page, label) {
  try {
    if (!isTrue(env("log_level", false))) return;
    const filename = `www/${getTimestamp()}-${label}.html`;
    const html = await page.content();
    fs.writeFileSync(filename, html, "utf8");
  } catch (_) {}
}

async function dumpState(page, label) {
  try {
    await safeScreenshot(page, label);
    await safeHtmlDump(page, label);
    const url = page.url();
    const title = await page.title().catch(() => "");
    console.log(`[DEBUG] ${label} url=${url} title=${title}`);
  } catch (_) {}
}

function getBaseUrl(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

async function gotoWithRetries(page, url, { tries = 3, waitUntil = "domcontentloaded", timeout = 120000 } = {}) {
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

async function isVisible(page, selector) {
  const el = await page.$(selector);
  if (!el) return false;
  const box = await el.boundingBox(); // null if hidden / display:none
  return !!box;
}

async function waitForEither(page, checks, timeoutMs = 30000, pollMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const c of checks) {
      try {
        if (await c()) return true;
      } catch (_) {}
    }
    await sleep(pollMs);
  }
  return false;
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

// ---------------- CAPTCHA detection (Puppeteer-safe) ----------------
async function detectCaptcha(page) {
  // URL-based
  try {
    const url = (page.url() || "").toLowerCase();
    if (url.includes("validatecaptcha") || url.includes("/captcha")) return true;
  } catch (_) {}

  // DOM-based
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
    } catch (_) {}
  }

  // Text-based
  try {
    const text = await page.evaluate(() => (document.body?.innerText || "").toLowerCase());
    if (text.includes("enter the characters you see below")) return true;
    if (text.includes("sorry, we just need to make sure you're not a robot")) return true;
    if (text.includes("type the characters")) return true;
  } catch (_) {}

  return false;
}

async function assertNoCaptcha(page, labelForArtifacts) {
  const isCaptcha = await detectCaptcha(page);
  if (!isCaptcha) return;

  await dumpState(page, `${labelForArtifacts}-captcha`);
  throw new Error("Amazon CAPTCHA detected. Aborting.");
}

// ---------------- Login helpers ----------------
async function clickContinueOrSubmitEmail(page) {
  const clicked = await clickFirst(page, [
    "#continue",
    "span#continue input",
    "input#continue",
    "button#continue",
    "input[type='submit']",
    "button[type='submit']",
  ]);
  if (clicked) return `clicked:${clicked}`;

  // submit form
  const submitted = await page.evaluate(() => {
    const email = document.querySelector("#ap_email, input[name='email']");
    const form = email?.closest("form");
    if (form) {
      form.submit();
      return true;
    }
    return false;
  });
  if (submitted) return "submitted:form.submit()";

  // Enter key
  try {
    await page.focus("#ap_email, input[name='email']");
    await page.keyboard.press("Enter");
    return "submitted:enter";
  } catch (_) {
    return null;
  }
}

async function submitPassword(page) {
  // Click common submit targets; fallback to Enter
  const clicked = await clickFirst(page, [
    "#signInSubmit",
    "input#signInSubmit",
    "button#signInSubmit",
    "button[type='submit']",
    "input[type='submit']",
    "#continue", // some variants still use continue after password
  ]);
  if (clicked) return `clicked:${clicked}`;

  try {
    await page.keyboard.press("Enter");
    return "submitted:enter";
  } catch (_) {
    return null;
  }
}

// ---------------- main ----------------
(async () => {
  const AMZ_SECRET = env("AMZ_SECRET", false); // optional if MFA not always required
  const AMZ_LOGIN = env("AMZ_LOGIN");
  const AMZ_PASS = env("AMZ_PASS");
  const DELETE_AFTER_DOWNLOAD = isTrue(env("DELETE_AFTER_DOWNLOAD", false));
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
    // Optional UA stabilization (helps sometimes)
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Ensure www/ exists for debug artifacts
    if (!fs.existsSync("www")) fs.mkdirSync("www", { recursive: true });

    // 1) Hit base domain
    const base = getBaseUrl(SIGNIN_URL);
    await gotoWithRetries(page, base, { tries: 2, waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(800);
    await dumpState(page, "01-main");

    // 2) Go to sign-in URL
    await gotoWithRetries(page, SIGNIN_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await dumpState(page, "02-signin");
    await assertNoCaptcha(page, "02-signin");

    // 3) Login state machine
    // Wait until we see either email or password or mfa
    await page.waitForSelector(
      "#ap_email, input[name='email'], #ap_password, input[name='password'], #auth-mfa-otpcode",
      { timeout: 60000 }
    );

    // EMAIL STEP (only if email input is visible)
    if (await isVisible(page, "#ap_email, input[name='email']")) {
      const emailSel = "#ap_email, input[name='email']";

      // Clear + type email
      await page.focus(emailSel);
      await page.click(emailSel, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type(emailSel, AMZ_LOGIN, { delay: 25 });

      // Trigger Amazon JS to enable Continue
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
      }, emailSel);

      await dumpState(page, "03-email-filled");
      await assertNoCaptcha(page, "03-email-filled");

      // Wait briefly for continue to become enabled (best-effort)
      await page
        .waitForFunction(() => {
          const btn = document.querySelector("#continue");
          return !btn || !btn.hasAttribute("disabled");
        }, { timeout: 5000 })
        .catch(() => {});

      const method = await clickContinueOrSubmitEmail(page);
      console.log(`[DEBUG] email submit method: ${method || "none"}`);

      // Confirm we advanced to password/mfa/captcha/challenge
      const movedForward = await waitForEither(
        page,
        [
          async () => await isVisible(page, "#ap_password, input[name='password']"),
          async () => (await page.$("#auth-mfa-otpcode")) !== null,
          async () => await detectCaptcha(page),
          async () => {
            const t = await page.title().catch(() => "");
            return (t || "").toLowerCase().includes("verify");
          },
        ],
        30000
      );

      await dumpState(page, "03-after-email-submit");
      await assertNoCaptcha(page, "03-after-email-submit");

      if (!movedForward) {
        await safeHtmlDump(page, "03-stuck-after-email");
        throw new Error("Stuck on email page: Continue/submit did not advance to password step.");
      }
    }

    // MFA STEP (if present)
    if (await page.$("#auth-mfa-otpcode")) {
      if (!AMZ_SECRET) {
        await dumpState(page, "mfa-no-secret");
        throw new Error("MFA required but AMZ_SECRET is missing.");
      }

      const totp = buildTotp(AMZ_SECRET, AMZ_LOGIN);
      const token = totp.generate();

      await page.type("#auth-mfa-otpcode", token, { delay: 15 });
      await dumpState(page, "04-mfa-filled");

      const otpClicked = await clickFirst(page, ["#auth-signin-button", "button[type='submit']", "input[type='submit']"]);
      if (!otpClicked) {
        await page.keyboard.press("Enter").catch(() => {});
      }

      await sleep(1500);
      await dumpState(page, "04-after-mfa-submit");
      await assertNoCaptcha(page, "04-after-mfa-submit");
    }

    // PASSWORD STEP (must be visible now; if not, stop and dump state)
    const pwVisible = await isVisible(page, "#ap_password, input[name='password']");
    if (!pwVisible) {
      await dumpState(page, "04-password-not-visible");
      throw new Error("Password step not reached (password input not visible).");
    }

    const pwSel = "#ap_password, input[name='password']";
    await page.focus(pwSel);
    await page.click(pwSel, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(pwSel, AMZ_PASS, { delay: 25 });

    await dumpState(page, "05-password-filled");

    const pwSubmitMethod = await submitPassword(page);
    console.log(`[DEBUG] password submit method: ${pwSubmitMethod || "none"}`);

    await sleep(1500);
    await dumpState(page, "05-after-password-submit");
    await assertNoCaptcha(page, "05-after-password-submit");

    // 4) Go to list URL
    await gotoWithRetries(page, LIST_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await dumpState(page, "06-after-list-goto");
    await assertNoCaptcha(page, "06-after-list-goto");

    // Wait for list OR detect we got bounced back
    const appeared = await waitForEither(
      page,
      [
        async () => (await page.$(".virtual-list")) !== null,
        async () => (await page.$("[data-testid='alexa-shopping-list']")) !== null,
        async () => (await page.$("#ap_email")) !== null,
        async () => (await page.$("#auth-mfa-otpcode")) !== null,
        async () => await detectCaptcha(page),
      ],
      60000
    );

    await dumpState(page, "07-list-wait-complete");
    await assertNoCaptcha(page, "07-list-wait-complete");

    // If we got bounced back to login, stop
    if (await page.$("#ap_email") || await page.$("#auth-mfa-otpcode")) {
      throw new Error("List page redirected back to login/MFA; cannot reach list UI.");
    }
    if (!appeared) {
      throw new Error("Timed out waiting for list UI to appear.");
    }

    // Give UI a moment to render items
    await sleep(1500);
    await dumpState(page, "08-list-rendered");

    // 5) Extract items (more resilient than a single selector)
    const itemTitles = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll(".virtual-list .item-title"),
        ...document.querySelectorAll("[data-testid='list-item'] .item-title"),
        ...document.querySelectorAll("li .item-title"),
      ];
      const titles = candidates
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean);
      return Array.from(new Set(titles));
    });

    const jsonFormattedItems = JSON.stringify(itemTitles, null, 2);
    if (isTrue(env("log_level", false))) console.log(jsonFormattedItems);

    // 6) Optional delete after download (best-effort)
    if (DELETE_AFTER_DOWNLOAD) {
      await page.$$eval(".item-actions-2 button", (buttons) => buttons.forEach((b) => b.click()));
      await sleep(1000);
      await dumpState(page, "09-after-delete-clicks");
    }

    // 7) Save output
    const outputDir = ".";
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "list_of_items.json"), jsonFormattedItems, "utf8");
  } catch (err) {
    await dumpState(page, "error");
    console.error("Scrape failed:", err?.message || err);
    throw err;
  } finally {
    await browser.close();
  }
})();
