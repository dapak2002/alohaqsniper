import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { origin, rankedLocations, slotEpoch, compareSlots, validateDetails } from './core.js';

const ALOHAQ_URL =
  'https://alohaq.honolulu.gov/?0&cat=1&name=Driver%20Licensing%20and%20Satellite%20Services';
const { values: opts } = parseArgs({
  options: {
    locations: { type: 'string', default: 'ala-moana' },
    origin: { type: 'string', default: 'ala-moana' },
    priority: { type: 'string', default: 'earliest' },
    watch: { type: 'boolean', default: false },
    interval: { type: 'string', default: '180' },
    before: { type: 'string' },
    list: { type: 'boolean' },
    help: { type: 'boolean' },
    'edit-details': { type: 'boolean' },
  },
});
if (opts.help) {
  console.log(`AlohaQ motor vehicle appointment finder
npm run cli -- [options]
  --locations ala-moana     Comma-separated IDs, or all
  --origin ala-moana        Location ID or latitude,longitude
  --priority earliest      Always earliest first; distance breaks time ties
  --list                   List locations by approximate straight-line miles
  --before YYYY-MM-DD       Only offer slots on or before this HST date
  --watch                  Repeat when no matching opening is found
  --interval 180           Seconds between scans (minimum 60)
  --edit-details           Edit saved first name, last name and phone; then exit

Default: earliest Ala Moana motor vehicle appointment. Select a result to
open signup, then enter your details and SMS code directly on AlohaQ.`);
  process.exit(0);
}
const detailsPath = new URL('../details.local.json', import.meta.url);
let details;
try {
  details = validateDetails(JSON.parse(await readFile(detailsPath, 'utf8')));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (opts['edit-details']) {
  const editor = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const firstName = await editor.question(`First name [${details?.firstName ?? ''}]: `);
    const lastName = await editor.question(`Last name [${details?.lastName ?? ''}]: `);
    const phone = await editor.question(
      `Phone [${details ? 'ending ' + details.phone.slice(-4) : ''}]: `,
    );
    details = validateDetails({
      firstName: firstName || details?.firstName,
      lastName: lastName || details?.lastName,
      phone: phone || details?.phone,
    });
    await writeFile(detailsPath, JSON.stringify(details, null, 2) + '\n', { mode: 0o600 });
    console.log('Saved local details. These are used only after you select a slot.');
  } finally {
    editor.close();
  }
  process.exit(0);
}
const sites = rankedLocations(opts.list ? 'all' : opts.locations, origin(opts.origin));
if (!['earliest', 'distance'].includes(opts.priority))
  throw new Error('Priority must be earliest or distance.');
const interval = Number(opts.interval);
if (!Number.isFinite(interval) || interval < 60)
  throw new Error('Interval must be at least 60 seconds.');
let cutoff = Infinity;
if (opts.before) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.before)) throw new Error('Use --before YYYY-MM-DD.');
  const day = new Date(`${opts.before}T00:00:00Z`);
  if (!Number.isFinite(+day) || day.toISOString().slice(0, 10) !== opts.before)
    throw new Error('Invalid --before date.');
  cutoff = +new Date(`${opts.before}T23:59:59-10:00`);
}
console.table(sites.map(({ id, miles }) => ({ location: id, 'approx. miles': miles.toFixed(1) })));
if (opts.list) process.exit(0);

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ timezoneId: 'Pacific/Honolulu' });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const rl = createInterface({ input: process.stdin, output: process.stdout });
let closing = false;
process.on('SIGINT', async () => {
  closing = true;
  rl.close();
  await browser.close();
  process.exit(130);
});

async function calendar(site) {
  await page.goto(ALOHAQ_URL);
  await page.locator('#newAppointment').click();
  await page
    .getByRole('button', { name: new RegExp(site.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .click();
  const services = page.getByRole('button').filter({ hasText: /MOTOR VEHICLES.*Other Services/i });
  await services.waitFor({ state: 'visible' });
  if (!(await services.isEnabled())) throw new Error('Motor vehicle service is unavailable here.');
  await services.click();
  await page.locator('#datepicker').waitFor({ state: 'visible' });
  // Wait for the availability request, not merely the loading heading.
  await page.waitForFunction(
    () => !document.querySelector('#headerSub')?.textContent.includes('Searching'),
  );
}

async function earliest(site) {
  await calendar(site);
  // AlohaQ initially displays the earliest available month. Inspect every
  // enabled day in it until a non-stale slot is found, without holding a slot.
  const links = page.locator('#datepicker').getByRole('link');
  const dates = await links.evaluateAll((es) =>
    es
      .map((e) => e.getAttribute('aria-label') || e.getAttribute('title') || '')
      .filter((s) => /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(s)),
  );
  if (!dates.length)
    throw new Error('No dated links found; availability is empty or the site layout changed.');
  for (const date of dates.sort((a, b) => slotEpoch(a, '12:00 AM') - slotEpoch(b, '12:00 AM'))) {
    if (slotEpoch(date, '12:00 AM') > cutoff) return null;
    await page.getByRole('link', { name: date, exact: true }).click();
    await page.waitForFunction(() => {
      const e = document.querySelector('#datetime');
      return e && !e.textContent.includes('Loading Available Tickets');
    });
    const times = await page
      .getByRole('button', { name: /\d{1,2}:\d{2}\s*[AP]M HST/i })
      .evaluateAll((es) => es.map((e) => e.getAttribute('aria-label') || e.textContent));
    const candidates = times
      .map((time) => ({
        ...site,
        date,
        time: time.replace(/\s+/g, ' ').trim(),
        epoch: slotEpoch(date, time),
      }))
      .filter((s) => s.epoch > Date.now() && s.epoch <= cutoff)
      .sort(compareSlots('earliest'));
    if (candidates.length) return candidates[0];
  }
  throw new Error(
    'Displayed month has no bookable times; retry later or inspect the calendar manually.',
  );
}

try {
  while (!closing) {
    const found = [];
    for (const site of sites) {
      console.log(`Checking ${site.name}…`);
      try {
        const slot = await earliest(site);
        if (slot) found.push(slot);
      } catch (error) {
        console.error(`${site.id}: ${error.message.split('\n')[0]}`);
      }
    }
    found.sort(compareSlots(opts.priority));
    if (!found.length) {
      if (!opts.watch) {
        console.log(
          'No matching results. Errors above indicate an incomplete scan, not proof of no availability.',
        );
        break;
      }
      console.log(`No matching results. Checking again in ${interval}s; Ctrl+C stops.`);
      await sleep(interval * 1000);
      continue;
    }
    console.log('\x07');
    console.table(
      found.map((s, i) => ({
        choice: i + 1,
        location: s.name,
        date: s.date,
        time: s.time,
        'approx. miles': s.miles.toFixed(1),
      })),
    );
    const answer = await rl.question(
      'Choose a number to open signup, r to rescan, or Enter to exit: ',
    );
    if (answer.toLowerCase() === 'r') continue;
    if (!answer) break;
    const selected = found[Number(answer) - 1];
    if (!/^\d+$/.test(answer) || !selected) {
      console.log('Invalid choice; rescanning.');
      continue;
    }
    // Recheck after the user chooses: openings can disappear during a scan.
    await calendar(selected);
    await page.getByRole('link', { name: selected.date, exact: true }).click();
    await page.getByRole('button', { name: selected.time, exact: true }).click();
    await page.locator('#fname').waitFor({ state: 'visible' });
    if (details) {
      await page.getByRole('textbox', { name: 'First name', exact: true }).fill(details.firstName);
      await page.getByRole('textbox', { name: 'Last name', exact: true }).fill(details.lastName);
      await page.getByRole('textbox', { name: 'Mobile number', exact: true }).fill(details.phone);
    }
    console.log(
      'Signup is open with saved details filled when available. Review them, request your SMS code and complete submission before the timer expires. A slot is not booked until AlohaQ confirms it.',
    );
    await rl.question('Press Enter only when you are finished (closes this browser): ');
    break;
  }
} catch (error) {
  console.error(`Stopped: ${error.message}`);
  await rl.question('Inspect the open browser. Press Enter when finished: ');
  process.exitCode = 1;
} finally {
  rl.close();
  await browser.close();
}
