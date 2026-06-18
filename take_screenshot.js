const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:3000/dev-login', { waitUntil: 'networkidle2' });
  // Click Research tab
  await page.waitForSelector('nav button, nav a', { timeout: 5000 }).catch(() => {});
  const tabs = await page.$$('nav button, .nav-tab, button');
  for (const tab of tabs) {
    const text = await page.evaluate(el => el.textContent, tab);
    if (text && text.trim() === 'Research') { await tab.click(); break; }
  }
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: 'store_screenshot.png', type: 'png', clip: { x: 0, y: 0, width: 1280, height: 800 } });
  console.log('Saved store_screenshot.png (1280x800)');
  await browser.close();
})();
