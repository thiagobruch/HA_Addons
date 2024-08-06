require('dotenv').config();
const puppeteer = require('puppeteer');
const OTPAuth = require('otpauth');  // For handling OTP
const fs = require('fs');

// Replace this with your actual secret key you get from the amazon add MFA page - and remove the spaces
const secret = process.env.AMZ_SECRET;
const amz_login = process.env.AMZ_LOGIN;
const amz_password = process.env.AMZ_PASS;

// Create a new OTPAuth instance
const totp = new OTPAuth.TOTP({
  issuer: 'YourIssuer',
  label: amz_login,
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  secret: OTPAuth.Secret.fromBase32(secret)
});

// Generate OTP
const token = totp.generate();

async function getOTP(secret) {
    const totp = new OTPAuth.TOTP({
        issuer: 'Amazon',
        label: 'Amazon OTP',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: secret
    });
    return totp.generate();
}

(async () => {
    const browser = await puppeteer.launch({
//({ headless: false });
	    headless: true,
	    defaultViewport: null,
	    executablePath: '/usr/bin/google-chrome',
	    args: ['--no-sandbox'],
	  });
    const page = await browser.newPage();

    // Navigate to Amazon login page
    await page.goto('https://www.amazon.com/ap/signin?openid.pape.max_auth_age=3600&openid.return_to=https%3A%2F%2Fwww.amazon.com%2Falexaquantum%2Fsp%2FalexaShoppingList%3Fref_%3Dlist_d_wl_ys_list_1&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=amzn_alexa_quantum_us&openid.mode=checkid_setup&language=en_US&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0');

    // Enter username
    await page.type('#ap_email', amz_login);

    // Enter password
    await page.type('#ap_password', amz_password);
    await page.click('#signInSubmit');
    await page.waitForNavigation();


    // Handle OTP (if required)
    if (await page.$('#auth-mfa-otpcode')) {
        await page.type('#auth-mfa-otpcode', token);
        await page.click('#auth-signin-button');
        await page.waitForNavigation();
    }

    // Navigate to Alexa Shopping List page
    await page.goto('https://www.amazon.com/alexaquantum/sp/alexaShoppingList?ref_=list_d_wl_ys_list_1');

    const pageContent = await page.content();
    sleep(3000, function() {
    // delay
    });

  let itemTitles = await page.$$eval(".virtual-list .item-title", items =>
    items.map(item => item.textContent.trim())
  );

  // Format each item as <listItem>
  let formattedItems = itemTitles.map(item => `${item}`);

  // Convert the array to JSON format
  let jsonFormattedItems = JSON.stringify(formattedItems, null, 2);

  
  // Save the JSON formatted list to default.htm
  const outputDir = '.';
  if (!fs.existsSync(outputDir)){
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(`${outputDir}/list_of_items.json`, jsonFormattedItems);
	

  // Display the JSON formatted list
  console.log(jsonFormattedItems);

  // Close the browser when done
    await browser.close();
})();
function sleep(time, callback) {
  var stop = new Date().getTime();
  while (new Date().getTime() < stop + time) {
    ;
  }
  callback();
}
