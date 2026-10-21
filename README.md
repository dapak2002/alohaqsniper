# AlohaQ SNIPER

A web app for finding appointments at Honolulu’s 15 AlohaQ satellite city hall and driver licensing offices. Select a location, service, and date range in the compact header. Available times fill the main page, earliest first. The calendar is available from the header. Express/release booking has its own page at `/express`, linked from the header.

## Start

Requires Node.js 20 or later. The web server uses only built-in Node.js modules; Chromium is not needed.

```sh
npm start
```

Open http://127.0.0.1:4317. Keep the terminal running while scanning or booking. On a fresh checkout:

```sh
npm install
npm start
```

## Using the frontend

1. Select **Location** and **Service**.
2. Set **From** and **To** dates (both included, Hawaii time). **Same day** makes them equal.
3. Click **Find appointments**. Only the chosen office and service are queried. Review available times below; **Calendar overview** summarizes available dates.
4. Enter first name, last name, and phone directly in the booking review. Every new review starts blank.
5. Open **Express booking** from the header for instant earliest-time booking or a timed run today. Choose its location, service, and target appointment date separately.
6. Review before confirming a booking. Services requiring additional eligibility steps link to AlohaQ. Manage and cancel appointments on the official site.

Changing the location, service, or dates clears the displayed results until you search again. Stop keeps results already collected. Timed runs remain visible in a status banner even when the advanced section is collapsed.

## Coverage and limits

- Scans cover your exact date range, up to each location’s booking limit. Same-day ranges are supported. Past days are not searched; a past start is moved to today when scanning. Requests run sequentially with 250 ms spacing, 20-second timeouts and one bounded retry for temporary server/rate-limit errors. Large scans across all services and locations can still take several minutes; progress shows the current location, service and date.
- Availability is searchable for every appointment-enabled service. Direct booking supports motor vehicle, disability parking/HOLO, and passport services. Use the official AlohaQ site for other services and their document/eligibility steps. Disabled services are listed as not bookable online.
- Errors, unavailable calendars and interrupted services appear next to the search status. Partial results are explicitly labeled; an empty view is not proof that an incomplete service has no openings.
- Times and dates are displayed in Hawaii Standard Time. Availability changes frequently; openings may disappear before booking.
- No separate browser is launched for frontend bookings. Submitting creates a real appointment. Existing appointments are never replaced automatically. Manage cancellations on AlohaQ. The app does not send separate SMS notifications; keep the displayed confirmation code.
- Registration renewals and several other express transactions may not require an appointment. Check the official list: https://www.honolulu.gov/csd/services-and-locations/

## Railway deployment

Deploy this directory as one Railway service. The included Dockerfile copies only application source, frontend assets, and package metadata; it does not include local contact or booking files. No database, volume, browser installation, or build step is required. `railway.json` sets the start command and `/health` healthcheck.

1. In Railway, choose **New Project → Deploy from GitHub repo → dapak2002/alohaqsniper**. Railway detects the Dockerfile and `railway.json`. No additional service is needed.
2. Under **Settings → Networking**, generate a public domain in Railway. The server reads `RAILWAY_PUBLIC_DOMAIN` automatically. If adding a custom domain, set `APP_ORIGIN=https://your-domain.example`.
3. Use **one replica in one region** and leave **Serverless disabled** so armed timers remain running. Do not redeploy during an armed run.
4. Railway supplies `PORT`; the server binds to `0.0.0.0` when hosted. Local `npm start` still uses `127.0.0.1:4317`.

See [Railway variables](https://docs.railway.com/variables/reference), [deployment configuration](https://docs.railway.com/config-as-code/reference), and [Serverless](https://docs.railway.com/deployments/serverless).

## In-memory sessions

Each browser session has its own search, preferences, booking deduplication records, and express job. A random HttpOnly, SameSite cookie identifies the session (Secure on the hosted domain). Tabs in the same browser share that session; different browsers/users have independent state. There are no user accounts or cross-device history. Idle sessions expire after 24 hours; active jobs are retained. Capacity is capped at 500 concurrent sessions.

The web app never reads or writes `*.local.json`. Existing local files are left untouched, and the older CLI may still use them. Contact details are sent to AlohaQ when booking and held only in server memory for that session. Restarting/redeploying clears all sessions, search results, booking receipts, and armed jobs. This does not cancel appointments already created on AlohaQ. Keep the confirmation code and verify uncertain outcomes on the official site before trying again. Request deduplication applies only for the lifetime of the session/server process.

Multiple visitors can use the service concurrently, but upstream AlohaQ limits and competing availability still apply. The service is not a durable job queue: an interrupted timed booking is not resumed automatically.

## Command-line tool

The earlier CLI is still available:

```sh
npm run cli
npm run cli -- --edit-details
npm run cli -- --list
npm run cli -- --locations all --watch --before 2026-10-30
```

The CLI inspects the initially available month. The frontend's API scanner fetches all available dates within its selected horizon and AlohaQ’s location-specific calendar limit. Both always prioritize appointment time before distance/location preference.

## Validation

```sh
npm test
```

Tests cover chronological ordering, location tie-breaking, distance calculations, malformed settings, contact validation and Hawaii date boundaries. Browser checks covered drag-and-drop persistence, calendar controls, and a live 30-day Ala Moana motor vehicle scan (288 openings across 10 dates at the time of the test). Earlier live API tests booked and cancelled one appointment each at Ala Moana and Wahiawa. Frontend booking logic is tested with mocked responses; no additional live appointment was created during its implementation.

## Read-only API used by the frontend

- `POST /wrk_est_time_1.php` with `category=1&kiosk=false&locations=`: current location IDs and service catalog.
- `POST /holidays.php`: holiday dates used by the public calendar.
- `GET /wrk_availability.php?l=ALAM&s=146&d=YYYY-MM-DD&m=YYYY-MM-DD&t=all`: dates with openings (`{ "msg": "success", "data": ["11/2/2026", ...] }`).
- `GET /wrk_get_availability.php?l=ALAM&s=146&d=2026-11-02`: available HST times (`["14:45:00", ...]`).

These public requests require no cookies, credentials or contact details in the tested flow. The client validates responses, filters holidays and dates outside the selected range, and preserves AlohaQ’s weekend/holiday extension of location-specific calendar limits. Unexpected responses are reported as incomplete scans. Booking uses `POST /wrk_book_appointment.php`. Appointment cancellation and management are available on the official AlohaQ site. These requests are made only for explicit user actions, with no automatic mutation retries. SMS calls are not replicated.

### Express booking

Use **Express booking** to choose a date and office without running a scan. Enter and review your booking details and select **Confirm & book earliest**. Select a service from the live catalog. The server validates the chosen service at that office, checks live availability, and books its earliest remaining time on that exact day (Hawaii time). The confirmation shows the actual time. If the day is full, nothing is booked; it never switches dates or offices. AlohaQ handles duplicate-booking errors; manage cancellations on the official site.

### Express release-time option

Under **Express & release booking**, select **At a release time today**, choose a location, target appointment date, and start time today (HST), then review and arm automatic booking. The time defaults to 4:14 PM HST and can be edited. The run starts **today in Hawaii** and targets the appointment date you selected, including weekends (there may be no openings). The server prepares the service lookup in advance and checks only that office/service/day every 500 ms until five minutes after the chosen release time, with a 500 ms buffer before the first check. Once an opening appears, it rechecks and submits the earliest time. There is no full calendar scan in this path. Empty availability is retried; submitted bookings are never automatically retried, and other errors stop the run. The actual cadence includes API response time.

Keep the server running (and the computer awake if running locally). Closing the tab does not stop the job, but keep the browser session to retrieve the result. Restarting the server disarms the run. The UI shows the target, countdown, checks, result, and a Stop button. Stop can cancel waiting/searching, but cannot retract a booking already being submitted. Arming uses the details entered in that booking review. This feature is off until explicitly armed and does not guarantee an opening or a successful booking.


All currently listed category-1 services are displayed per office, including notices for services unavailable online. Searches query only the selected service and office. Every office is available in the Location selector. Express and scheduled booking pass the selected service ID, validate its current availability and service type, and never substitute a different service. Driver licensing/state ID/permit/CDL services are listed for discovery and scanning, with an official-site link for completion rather than skipping their required checks.
