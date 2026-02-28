/**
 * scrapeAmazon.js (full rewrite with robust login + MFA (/ap/mfa) handling)
 * - Home Assistant add-on / Alpine friendly
 * - Uses system Chromium + puppeteer-core
 * - Robust email -> continue -> password flow (won't silently remain on email page)
 * - Robust MFA handling for Amazon /ap/mfa and #auth-mfa-otpcode variants
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
    if(log_level == "true"){
      console.log(`[DEBUG1] ${label} url=${url} title=${title}`);
    }
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
  const box = await el.boundingBox();
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
  try {
    const url = (page.url() || "").toLowerCase();
    if (url.includes("validatecaptcha") || url.includes("/captcha")) return true;
  } catch (_) {}

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

  try {
    await page.focus("#ap_email, input[name='email']");
    await page.keyboard.press("Enter");
    return "submitted:enter";
  } catch (_) {
    return null;
  }
}

async function submitPassword(page) {
  const clicked = await clickFirst(page, [
    "#signInSubmit",
    "input#signInSubmit",
    "button#signInSubmit",
    "button[type='submit']",
    "input[type='submit']",
    "#continue",
  ]);
  if (clicked) return `clicked:${clicked}`;

  try {
    await page.keyboard.press("Enter");
    return "submitted:enter";
  } catch (_) {
    return null;
  }
}

/**
 * Robust MFA handler:
 * - Detects /ap/mfa and classic #auth-mfa-otpcode
 * - Finds OTP input via multiple fallbacks
 * - Submits and verifies we leave MFA page before proceeding
 */
async function handleTwoStepIfPresent(page, { secret, loginLabel }) {
  const url = (page.url() || "").toLowerCase();
  const title = (await page.title().catch(() => "")).toLowerCase();

  const looksLikeMfa =
    url.includes("/ap/mfa") ||
    title.includes("two-step verification") ||
    title.includes("two step verification") ||
    (await page.$("#auth-mfa-otpcode")) ||
    (await page.$("input[name='otpCode']")) ||
    (await page.$("input[name='code']"));

  if (!looksLikeMfa) return false;

  if (!secret) {
    await dumpState(page, "mfa-missing-secret");
    throw new Error("MFA required but AMZ_SECRET is missing.");
  }

  await dumpState(page, "mfa-detected");
  await assertNoCaptcha(page, "mfa-detected");

  // Wait for OTP input to appear (selectors vary)
  const otpSelectors = [
    "#auth-mfa-otpcode",
    "input#auth-mfa-otpcode",
    "input[name='otpCode']",
    "input[name='code']",
    "input[type='tel']",
  ];

  let otpSel = null;
  for (const sel of otpSelectors) {
    try {
      if (await isVisible(page, sel)) {
        otpSel = sel;
        break;
      }
    } catch (_) {}
  }

  if (!otpSel) {
    // Give Amazon UI a moment (sometimes loads late)
    await sleep(1500);
    for (const sel of otpSelectors) {
      try {
        if (await isVisible(page, sel)) {
          otpSel = sel;
          break;
        }
      } catch (_) {}
    }
  }

  if (!otpSel) {
    await dumpState(page, "mfa-otp-field-not-found");
    throw new Error("MFA page detected but OTP input field was not found.");
  }

  // Generate fresh TOTP right now
  const totp = buildTotp(secret, loginLabel);
  const token = totp.generate();

  // Fill OTP
  await page.focus(otpSel);
  await page.click(otpSel, { clickCount: 3 }).catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.type(otpSel, token, { delay: 20 });

  // Optional "remember device" checkbox (best effort)
  await clickFirst(page, [
    "input[name='rememberDevice']",
    "#auth-mfa-remember-device",
    "input[type='checkbox']",
  ]).catch(() => {});

  await dumpState(page, "mfa-otp-filled");

  // Submit MFA (selectors vary)
  const submitSel = await clickFirst(page, [
    "#auth-signin-button",
    "input#auth-signin-button",
    "button#auth-signin-button",
    "button[type='submit']",
    "input[type='submit']",
  ]);

  if (!submitSel) {
    await page.keyboard.press("Enter").catch(() => {});
  }

  await sleep(2000);
  await dumpState(page, "mfa-after-submit");
  await assertNoCaptcha(page, "mfa-after-submit");

  // Confirm we left MFA page (or got bounced)
  const leftMfa = await waitForEither(
    page,
    [
      async () => !(page.url() || "").toLowerCase().includes("/ap/mfa"),
      async () => (await page.$(".virtual-list")) !== null,
      async () => (await page.$("#ap_email")) !== null,
    ],
    30000
  );

  if (!leftMfa) {
    await dumpState(page, "mfa-stuck");
    throw new Error("Submitted MFA code but did not leave the MFA page.");
  }

  if (await page.$("#ap_email")) {
    await dumpState(page, "mfa-bounced-to-login");
    throw new Error("After MFA submit, Amazon redirected back to login (code wrong or challenge required).");
  }

  return true;
}

// ---------------- main ----------------
(async () => {
  const AMZ_SECRET = env("AMZ_SECRET", false);
  const AMZ_LOGIN = env("AMZ_LOGIN");
  const AMZ_PASS = env("AMZ_PASS");
  const DELETE_AFTER_DOWNLOAD = isTrue(env("DELETE_AFTER_DOWNLOAD", false));
  const SIGNIN_URL = env("Amazon_Sign_in_URL");
  const LIST_URL = env("Amazon_Shopping_List_Page");
  const chromiumPath = env("CHROMIUM_PATH", false) || "/usr/bin/chromium";
  const log_level = env("log_level");
  const log_level = String(process.env.log_level || "")
  .trim()
  .toLowerCase() === "true";

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
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    if (!fs.existsSync("www")) fs.mkdirSync("www", { recursive: true });

    // 1) Main domain
    const base = getBaseUrl(SIGNIN_URL);
    await gotoWithRetries(page, base, { tries: 2, waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(800);
    await dumpState(page, "01-main");

    // 2) Sign-in page
    await gotoWithRetries(page, SIGNIN_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await dumpState(page, "02-signin");
    await assertNoCaptcha(page, "02-signin");

    // 3) Login state machine
    await page.waitForSelector(
      "#ap_email, input[name='email'], #ap_password, input[name='password'], #auth-mfa-otpcode",
      { timeout: 60000 }
    );

    // Email step (only if visible)
    if (await isVisible(page, "#ap_email, input[name='email']")) {
      const emailSel = "#ap_email, input[name='email']";

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

      // Best-effort wait for #continue to be enabled
      await page
        .waitForFunction(() => {
          const btn = document.querySelector("#continue");
          return !btn || !btn.hasAttribute("disabled");
        }, { timeout: 5000 })
        .catch(() => {});

      const method = await clickContinueOrSubmitEmail(page);
      if(log_level == "true"){
        console.log(`[DEBUG2] email submit method: ${method || "none"}`);
      }
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

    // Password step (must be visible if MFA not already present)
    if (await isVisible(page, "#ap_password, input[name='password']")) {
      const pwSel = "#ap_password, input[name='password']";

      await page.focus(pwSel);
      await page.click(pwSel, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type(pwSel, AMZ_PASS, { delay: 25 });

      await dumpState(page, "05-password-filled");
      await assertNoCaptcha(page, "05-password-filled");

      const pwSubmitMethod = await submitPassword(page);
      if(log_level == "true"){
      console.log(`[DEBUG3] password submit method: ${pwSubmitMethod || "none"}`);
      }
      await sleep(1500);
      await dumpState(page, "05-after-password-submit");
      await assertNoCaptcha(page, "05-after-password-submit");
    }

    // MFA step (handles /ap/mfa and #auth-mfa-otpcode variants)
    await handleTwoStepIfPresent(page, { secret: AMZ_SECRET, loginLabel: AMZ_LOGIN });

    // After MFA, we should not be on login forms anymore
    await assertNoCaptcha(page, "post-mfa");
    await dumpState(page, "post-mfa");

    // 4) Go to list URL
    await gotoWithRetries(page, LIST_URL, { tries: 3, waitUntil: "domcontentloaded", timeout: 120000 });
    await dumpState(page, "06-after-list-goto");
    await assertNoCaptcha(page, "06-after-list-goto");

    // Wait for list OR detect bounce to login/mfa/captcha
    const ok = await waitForEither(
      page,
      [
        async () => (await page.$(".virtual-list")) !== null,
        async () => (await page.$("[data-testid='alexa-shopping-list']")) !== null,
        async () => (await page.$("#ap_email")) !== null,
        async () => (await page.$("#auth-mfa-otpcode")) !== null,
        async () => (await detectCaptcha(page)) === true,
      ],
      60000
    );

    await dumpState(page, "07-list-wait-complete");
    await assertNoCaptcha(page, "07-list-wait-complete");

    if (!ok) throw new Error("Timed out waiting for list UI to appear.");
    if (await page.$("#ap_email") || await page.$("#auth-mfa-otpcode")) {
      throw new Error("List page redirected back to login/MFA; cannot reach list UI.");
    }

    await sleep(1500);
    await dumpState(page, "08-list-rendered");

    // 5) Extract items (resilient)
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

    if (isTrue(env("log_level", false))) {
      console.log(jsonFormattedItems);
    }

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
