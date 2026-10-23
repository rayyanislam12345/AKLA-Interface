// Checks the simplified site against a running Hub: the sidebar, Use with
// Claude, a project page, Record Meeting and Help. Signs in with EMAIL and PW
// from the environment (never printed) and saves screenshots in .smoke-tmp/.
//
//   EMAIL=… PW=… node scripts/smoke-wave1.mjs                 # the live site
//   HUB_URL=http://localhost:8080 EMAIL=… PW=… node scripts/smoke-wave1.mjs
//
// Read-only: it opens pages and reads them; it creates, saves and deletes nothing.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = (process.env.HUB_URL ?? 'https://akla-interface.vercel.app').replace(/\/$/, '');
const { EMAIL, PW } = process.env;
if (!EMAIL || !PW) {
  console.error('Set EMAIL and PW for a Hub account first.');
  process.exit(2);
}
mkdirSync('.smoke-tmp', { recursive: true });

const results = [];
const check = (ok, what) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`);
};

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await page.goto(`${base}/auth`);
  await page.fill('#signin-email', EMAIL);
  await page.fill('#signin-password', PW);
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/matters/, { timeout: 30_000 }).catch(() => {});
  check(new URL(page.url()).pathname === '/matters', 'signing in lands on Projects');

  const sidebar = page.locator('[data-sidebar="sidebar"]').first();
  await sidebar.waitFor();
  const text = await sidebar.innerText();
  for (const item of ['Projects', 'Record Meeting', 'Timesheet', 'Firm Library', 'Legal Updates', 'Use with Claude', 'Help']) {
    check(text.includes(item), `sidebar shows ${item}`);
  }
  for (const gone of ['Dashboard', 'Clients', 'AI Assistant', "Today's Timesheet"]) {
    check(!text.includes(gone), `sidebar no longer shows ${gone}`);
  }
  await page.mouse.move(900, 400);
  await page.waitForTimeout(400);
  check((await sidebar.innerText()).includes('Projects'), 'the sidebar keeps its labels when the mouse leaves it');
  await page.screenshot({ path: '.smoke-tmp/wave1-projects.png' });

  await page.goto(`${base}/claude`);
  await page.getByRole('heading', { name: 'Use with Claude' }).waitFor();
  check((await page.locator('code').first().innerText()).includes('/mcp'), 'Use with Claude shows the connector address');
  await page.screenshot({ path: '.smoke-tmp/wave1-claude.png', fullPage: true });

  await page.goto(`${base}/matters`);
  const firstProject = page.locator('table tbody tr').first();
  if (await firstProject.count()) {
    await firstProject.click();
    await page.waitForURL(/\/matters\/[0-9a-f-]{36}/);
    await page.getByRole('button', { name: 'Open in Claude' }).waitFor();
    check(await page.getByRole('button', { name: 'Record meeting' }).isVisible(), 'a project offers Record meeting');
    const firstCard = (await page.locator('main h3').first().innerText()).trim();
    check(firstCard === 'Documents', `a project opens on its documents (first card: ${firstCard})`);
    check(await page.getByRole('button', { name: /Show empty sections|Hide empty sections/ }).isVisible(), 'empty sections wait behind one button');
    await page.screenshot({ path: '.smoke-tmp/wave1-project.png', fullPage: true });
    const projectId = page.url().match(/matters\/([0-9a-f-]{36})/)[1];
    await page.goto(`${base}/record-meeting?matter=${projectId}`);
    await page.getByRole('button', { name: /Start recording/ }).waitFor();
    check(await page.getByText(/Recorder ready|recorder isn't answering|isn't set up/).first().isVisible({ timeout: 10_000 }).catch(() => false), 'Record Meeting says whether the recorder is ready');
    check(await page.getByText('Before the meeting').isVisible(), 'Record Meeting is laid out before / during / after');
    const chosen = await page.getByRole('combobox').first().innerText();
    check(!/Choose the project/.test(chosen), `Record Meeting starts on the project it came from (${chosen.trim()})`);
    await page.screenshot({ path: '.smoke-tmp/wave1-meeting.png' });
  } else {
    console.log('SKIP: no projects to open');
  }

  await page.goto(`${base}/legal-updates`);
  check(await page.getByRole('heading', { name: 'Legal Updates' }).first().isVisible({ timeout: 15_000 }).catch(() => false), 'Legal Updates has its own page');
  await page.screenshot({ path: '.smoke-tmp/wave1-legal-updates.png', fullPage: true });

  await page.goto(`${base}/help`);
  await page.getByText('Using Claude').first().waitFor();
  check(true, 'Help has the Using Claude section');
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed. Screenshots are in .smoke-tmp/.` : 'All checks passed. Screenshots are in .smoke-tmp/.');
process.exit(failed ? 1 : 0);
