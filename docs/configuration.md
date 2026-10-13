# Configuration reference

envdiff reads `envdiff.config.yaml` (or `.yml`, `.json`, `.mjs`, `.js`) from the
current directory, or the file given with `-c`. `envdiff init` writes a commented
starter. Command-line flags override the file.

- **Environment variables**: `${NAME}` in any string is replaced by the variable
  (unset or empty is an error, so a login never types an empty password);
  `${NAME:-default}` falls back instead; `$${NAME}` is a literal `${NAME}`.
  JavaScript configs read `process.env` themselves and may export a function.
- Unknown top-level keys produce a warning (usually a typo).
- Patterns ("regex") are case-insensitive JavaScript regular expressions; an
  invalid one is treated as a literal substring.

## Environments: `baseline`, `candidate`

| Key | Default | |
|---|---|---|
| `url` | — | Where the environment lives. Its path decides what is compared: the same path on both sides scopes the whole origin and starts there; different paths (`/preview/pr-12` vs `/preview/pr-13`) make each path that side's root. |
| `ref` | — | A branch, tag or commit instead of `url`; see `branches`. |
| `label` | host | Display name ("UAT"). |
| `basePath` | derived | Force the path prefix pages are compared under. |
| `headers` | `{}` | Extra request headers — **only** for requests to this environment's own origin. |
| `headerHosts` | `[]` | Regexes on `host:port` of other hosts that should also get `headers` (e.g. a separate API host). |
| `httpCredentials` | — | `{ username, password }` for HTTP basic/digest auth; answered only for this origin. |
| `storageState` | — | Playwright storage state (cookies + localStorage), e.g. from `envdiff login`. |
| `cookies` | `[]` | `[{ name, value, domain?, path? }]`; without `domain` they apply to this origin. |
| `auth` | — | Per-environment login, overriding the top-level `auth`. |
| `env` | — | A named environment (see below) this side is; the command line sets it for `envdiff prod uat`. |
| `user` | — | The user to log in as on this side, overriding `user`. |

Command line: positional arguments, `--baseline-label`, `--baseline-header`,
`--baseline-auth`, `--baseline-storage` (and `candidate-…`, or unprefixed for both).
Environment: `ENVDIFF_HEADERS`, `ENVDIFF_BASELINE_HEADERS`, `ENVDIFF_CANDIDATE_HEADERS`
("Name: value" per line, or separated by `;;`), `ENVDIFF_AUTH`,
`ENVDIFF_BASELINE_AUTH`, `ENVDIFF_CANDIDATE_AUTH` ("user:password").

## Named environments: `environments`, `user`

```yaml
environments:
  prod: { url: https://app.example.com, label: PROD }
  uat:
    url: https://uat.example.com
    users:
      admin: { username: "${UAT_ADMIN}", password: "${UAT_ADMIN_PW}" }
user: admin            # log in as admin in both (--user admin); "none" = don't log in
```

An environment takes any of the `baseline`/`candidate` keys, plus `users`. A name
given on the command line (`envdiff prod uat`) or as `baseline.env` picks one. Without
a config file, environment variables do the same:

| Variable | |
|---|---|
| `ENVDIFF_<ENV>_URL` | The environment's address; makes `<env>` a name the command line accepts. |
| `ENVDIFF_<ENV>_USERNAME`, `ENVDIFF_<ENV>_PASSWORD` | Its default user. |
| `ENVDIFF_<ENV>_<USER>_USERNAME`, `…_PASSWORD` | Another user, chosen with `--user <user>` (`user`). |
| `ENVDIFF_<ENV>[_<USER>]_TOTP` | Authenticator secret (base32, or an `otpauth://` URI) for logins that ask for a one-time code. |
| `ENVDIFF_BASELINE_USERNAME` / `_PASSWORD` / `_TOTP` (and `CANDIDATE`) | Per side; override all of the above. |

`<ENV>` and `<USER>` are upper-cased with anything but letters and digits turned into
`_`: user `qa-admin` on `uat` is `ENVDIFF_UAT_QA_ADMIN_USERNAME`. A user that has no
credentials is an error naming the variables to set; logging in to only one side is
a warning. The report shows who was logged in, with the username masked.

## `auth`

How to log in. With credentials and no `auth` at all, envdiff finds the login form
itself; `auth` is for pointing it at the form, checking it worked, or scripting it.
Runs once per environment before anything is compared, with writes allowed (a login
form is a POST). The session — cookies, localStorage, IndexedDB and sessionStorage —
is reused for every page and viewport; if it ends mid-run (a page shows the login
form where the other environment doesn't), envdiff logs in again.

| Key | |
|---|---|
| `loginUrl` | Path or URL to open first (default: the environment's URL). The automatic login follows a "Log in" link from there when there is no form. |
| `steps` | A scripted login: a list of [steps](#steps), with `{{username}}`, `{{password}}` and `{{totp}}` filled in per environment. |
| `username`, `password`, `totp` | Credentials, if not from the variables above. |
| `usernameSelector`, `passwordSelector`, `submitSelector` | Point the automatic login at the right fields when it guesses wrong. |
| `successUrl` | Glob the URL must match afterwards, e.g. `"**/dashboard**"`. |
| `successSelector` | Element that must be visible afterwards. |

The automatic login fills username and password (on one screen or two), submits, and
answers a one-time-code prompt from `totp`. A refused login ("Invalid email or
password"), a CAPTCHA, a code it has no secret for, or a form still showing after 45
seconds stops the run (exit 2) with that reason and saves `login-failed-<side>.png`
in the report directory. Once logged in, the login page is no longer crawled and
"Log in" controls aren't clicked. The crawl also starts where the app lands after
logging in.

## `branches`

How a `ref` becomes something to load. Pick one:

| Key | |
|---|---|
| `urlTemplate` | Preview URL pattern. `{branch}` is the slug (`feature/Login` → `feature-login`), `{branch_raw}` the URL-encoded name. |
| `serve` | Build and serve each branch locally (below). |

`branches.serve`:

| Key | Default | |
|---|---|---|
| `repo` | `.` | The git repository. Branches are found locally, as `origin/<name>`, or fetched. |
| `cwd` | `.` | App directory inside the repository. |
| `install` | — | e.g. `npm ci` |
| `build` | — | e.g. `npm run build` |
| `start` | **required** | e.g. `npm start -- --port $PORT`. Must listen on the port it is given. |
| `port` | `4100` | Baseline port; the candidate gets `port + 1`. |
| `portEnv` | `PORT` | Environment variable carrying the port. |
| `readyPath` | `/` | Polled until it answers below 500. |
| `readyTimeout` | `180` | Seconds. |
| `env` | `{}` | Extra environment for install/build/start. |

Each branch is checked out into a temporary `git worktree`; command output goes to
`serve-baseline.log` / `serve-candidate.log` in the report directory. Servers and
worktrees are removed at the end.

## `crawl`

| Key | Default | |
|---|---|---|
| `startPaths` | `["/"]` | Start pages. With the default, the path of the baseline URL is used. |
| `maxPages` | `25` | Pages to compare (each in every viewport). |
| `maxDepth` | `3` | Link hops from a start page. |
| `samplesPerPattern` | `2` | Pages per route shape: `/products/1` and `/products/2`, not 500 products. Ids, UUIDs, hashes and slugs with ids are recognised, and a parent with more than 10 children is treated as a list. |
| `include` | `[]` | Only crawl paths matching one of these. |
| `exclude` | `[]` | Never crawl paths matching these. Logout paths and file downloads are always excluded. |
| `sitemap` | `false` | Also seed from `/sitemap.xml` (and nested sitemaps). |
| `ignoreQuery` | `false` | Treat `?a=1` and `?a=2` as the same page. Tracking parameters (`utm_*`, `gclid`…) are always dropped. |
| `checkLinks` | `true` | Fetch links found beyond the page budget and report ones that break on the candidate. |
| `enabled` | `true` | `false` (`--no-crawl`): compare no pages, only run the journeys. |
| `maxLinkChecks` | `150` | |

## `explore`

Clicking every safe control on each page, in both environments.

| Key | Default | |
|---|---|---|
| `enabled` | `true` | |
| `maxActionsPerPage` | `25` | `0` disables clicking. |
| `maxPerName` | `2` | Identical controls (40 "Add to cart" buttons) clicked at most this often per page. |
| `depth` | `1` | `2` also clicks what clicks reveal (menu items, dialog buttons), and so on. Max 4. |
| `includeLinks` | `false` | Also click plain links. They are crawled anyway; JavaScript links (`href="#"`, `javascript:`) are always clicked. |
| `selects` | `true` | Exercise dropdowns by picking an option that exists on both sides. A dropdown or toggle whose change shows nothing yet is followed by the nearby Apply / Search / Go button. |
| `hover.charts` / `hover.points` | `4` / `3` | Charts per page whose points are hovered, and points per chart (first, middle, last); their tooltips are compared. `0` charts turns it off. |
| `actionTimeout` | `4000` | ms to wait for a control to be clickable. |
| `settleTimeout` | `2500` | ms to wait for the page to settle after an action. |
| `viewports` | `"first"` | `"all"` explores in every viewport (slower). |
| `skip.text` / `skip.selectors` | `[]` | Never click matching controls (name/test id/href regex, or CSS selector). |
| `allow.text` / `allow.selectors` | `[]` | Click these even if they match the deny list. |

Controls in the site header, navigation and footer are clicked on the first page
they appear on, not on every page.

## `safety`

| Key | Default | |
|---|---|---|
| `allowMutations` | `false` | Let the app send POST/PUT/PATCH/DELETE. **Only for disposable data.** Blocked requests are still recorded with the shape of their body. |
| `allowRequests` | `[]` | URL regexes let through despite being writes — POST endpoints that only read (search, pricing). |
| `graphql` | `true` | Let GraphQL queries through while blocking mutations. |
| `useDefaultDenyList` | `true` | Never click controls named like delete, remove account, pay, buy now, place order, unsubscribe, log out… |
| `allowBotSensors` | `true` | Let bot-protection sensors post to their machine-generated paths (`/q_Rb83nWfxeJtPm2ka9vL0dZ/…`). They write no app data, and blocking them can get the session flagged. |

## `viewports`

List of `desktop` (1366×900), `laptop` (1280×800), `tablet` (820×1180, touch),
`mobile` (390×844, touch), `"WIDTHxHEIGHT"`, or
`{ name, width, height, isMobile?, hasTouch?, deviceScaleFactor?, userAgent? }`.
The first is the primary: interactions, text, accessibility, performance and API
checks run there; the others add visual, layout and availability checks, and
report only what differs from the primary.

## `browser`

| Key | Default | |
|---|---|---|
| `name` | `chromium` | `chromium`, `firefox` or `webkit` (install it with `npx playwright install <name>`). |
| `channel` | — | Use an installed browser: `chrome`, `msedge`. |
| `executablePath` | — | Or a specific binary (also `ENVDIFF_BROWSER_PATH`). |
| `headless` | `true` | `--headed` to watch. |
| `locale` / `timezoneId` / `colorScheme` | `en-US` / `UTC` / `light` | Same for both environments. |
| `userAgent` | Playwright's | |
| `ignoreHTTPSErrors` | `false` | For self-signed certificates on internal environments. |
| `args` | `[]` | Extra browser arguments. |
| `proxy` | — | `{ server, bypass?, username?, password? }` to route the browser through a proxy (`--proxy http://proxy.corp:3128`). Chromium on Linux also honours `HTTPS_PROXY`. |

## `stabilize`

When a page counts as "ready": for `quietMs` there has been no network activity, no DOM change, no scrolling, no client-side navigation (`pushState`, `replaceState`, hash changes) and no long task on the main thread. The last two catch single-page apps that finish booting seconds after `load`, run their router again and re-render.

Pages are captured from the top. envdiff checks that a page held still while it was captured (same scroll position, size, address and text before and after) and captures again if it didn't. If the app's router ran again after envdiff scrolled through the page, envdiff scrolls through it again, because a re-render can hide sections that only appear once scrolled into view.

The list of controls on a page is what a person scrolling through it would see. Transitions and animations still running are jumped to their end first, as the screenshot does. A control that was on show at some point while scrolling through counts even if the page hides it again once it's off screen.

| Key | Default | |
|---|---|---|
| `quietMs` | `400` | |
| `maxWaitMs` | `10000` | Give up waiting after this long and use the page as it is. |
| `ignoreMutations` | `[]` | Selectors whose changes don't count (carousels, tickers, clocks). |
| `scroll` | `true` | Scroll through each page so lazy and scroll-revealed content loads before the full-page screenshot. |
| `dismissConsent` | `true` | Click "Accept" on common cookie banners (OneTrust, Cookiebot, Didomi, Usercentrics…). |
| `confirm` | `true` | Before reporting a difference on a page or an interaction, repeat it in both environments and keep only what happens both times. Differences that don't reproduce are listed in the report as "didn't reproduce" and aren't counted. Set to `false` for faster, noisier runs. |
| `busySelectors` | grid overlays, chart loading labels, common spinners | Loading indicators to wait out: a page isn't settled while one shows (AG Grid's "Loading…" overlay, Highcharts' loading label, Material/Bootstrap/PrimeNG/Kendo spinners, `[aria-busy=true]`…). One still showing a few seconds after everything else went quiet is given up on. |

## `visual`

| Key | Default | |
|---|---|---|
| `enabled` | `true` | |
| `threshold` | `0.1` | Per-pixel colour tolerance (0–1). |
| `minRatio` | `0.002` | Differences smaller than this share of the page are ignored. |
| `majorRatio` | `0.3` | At or above this share the finding is major (likely broken layout). |
| `mask` | `[]` | Selectors painted over in screenshots and removed from text comparison. |
| `hide` | `[]` | Selectors hidden (`visibility: hidden`) in screenshots. |
| `fullPage` | `true` | |
| `maxHeight` | `10000` | Full-page screenshots are cut at this height. |
| `freezeTime` | — | ISO time `Date.now()` returns in both environments. |

## `data`

`different` (default) or `same`: do the two environments hold the same data?

- **`different`** — UAT and production, say. Numbers in text are compared for format,
  not value (`Revenue $1,204,330` and `Revenue $998,120` read the same); grid cells
  for their format — amounts, percentages, dates, decimals, thousands separators,
  `NaN` — not their values; charts for series, legend and axes, not points; and
  grids and charts are left out of pixel comparisons (hatched in the diff image). A
  grid or chart with no data on the candidate is minor, since it may be the data.
- **`same`** (`--same-data`) — two builds against one backend: cell values, row
  counts, chart points and categories, and every number are compared too.

Grids are read from AG Grid (any version) and from grids that follow the ARIA grid
pattern; charts from Highcharts' DOM, and from `window.Highcharts` when the page
exposes it. Neither is compared as text or as controls: their own checks cover them
(finding types `grid.*` and `chart.*`).

## `text`, `layout`

| Key | Default | |
|---|---|---|
| `text.enabled` | `true` | Diff the visible text. |
| `text.normalize` | `true` | Collapse times, dates, "3 minutes ago", UUIDs and hashes first. |
| `text.severity` | `minor` | |
| `layout.enabled` | `true` | Report moved/resized controls and content shifts. |
| `layout.tolerance` | `6` | Pixels of movement tolerated. |

## `ignore`

| Key | |
|---|---|
| `text` | Regexes removed from text before comparing. |
| `console` | Console messages and exceptions to ignore. |
| `requests` | Request URL regexes to ignore (failures and API shapes). Common analytics, ads and session-replay hosts are ignored already, as are same-origin calls whose path starts with a machine-generated segment (`/q_Rb83nWfxeJtPm2ka9vL0dZ/...`): bot-protection scripts post there, and the path differs per environment. |
| `selectors` | Elements ignored for controls, text, forms and accessibility. |
| `findings` | Finding ids (shown in the report) or type globs (`perf.*`, `a11y.color-contrast`) to drop. |

## `severity`

Re-grade finding types: `{ "perf.*": info, "content.text": info, "a11y.*": major }`.

## `a11y`, `perf`, `api`

| Key | Default | |
|---|---|---|
| `a11y.enabled` | `true` | Run axe-core on each page in the primary viewport. |
| `a11y.minImpact` | `moderate` | `minor`, `moderate`, `serious`, `critical`. |
| `a11y.tags` | WCAG 2.0/2.1 A and AA | axe rule tags. |
| `perf.enabled` | `true` | Compare TTFB, FCP, LCP, load, CLS and page weight. |
| `perf.tolerance` | `0.5` | Relative slowdown tolerated (0.5 = 50%)… |
| `perf.minDeltaMs` | `750` | …and the absolute difference must exceed this. |
| `api.enabled` | `true` | Compare the JSON shape of XHR/fetch responses, per endpoint across the run. |
| `api.maxBodyBytes` | `1000000` | Larger responses are skipped. |

## `journeys`

```yaml
journeys:
  - name: Checkout
    allowMutations: false        # true for disposable environments
    screenshotEveryStep: false   # screenshots are always taken at `screenshot` steps and on failure
    steps: [...]
```

Steps are plain English (a string) or an exact action (an object, below), mixed
freely. Journeys start at the first start path unless their first step opens an
address. `--journey "<text>"` and `--journey-file <file>` add journeys from the command
line: one step per line or separated by `;`, `Journey: <name>` (or a Markdown
heading) starting each journey, numbering and bullets ignored. A YAML/JSON file holds
a list of `{ name, steps }`.

### Plain-English steps

| Step | Examples |
|---|---|
| Go to | `Go to Orders` (clicks the link or menu item), `Open Settings > Users`, `Go to /#/orders` |
| Click | `Click Apply`, `Click the Export CSV button`, `Open the user menu`, `Double-click Revenue` |
| Type | `Type "west" into Search orders`, `Fill Email with {{username}}`, `Search for Acme` (then Enter), `Clear the search box` |
| Choose | `Select "Last 30 days" from Date range` (native or custom dropdowns), `Set Date range to This year` |
| Toggle | `Check Remember me`, `Uncheck "Show archived"` |
| Keys | `Press Enter`, `Press Escape` |
| Hover | `Hover over Customer`, `Hover over the Monthly revenue chart`, `Hover over the last point of the Sales chart` |
| Grids | `Sort by Amount descending`, `Next page`, `Click the first row of the Orders grid` |
| Wait | `Wait 2 seconds`, `Wait for Sales by region to appear`, `Wait until Loading disappears` |
| Expect | `Expect to see "Saved"`, `I should not see Something went wrong`, `Verify the URL contains /orders`, `Make sure the Orders grid has rows` (or `no` / `3` / `at least 3` rows), `Check that the Revenue chart shows Target`, `Expect no errors`, `The Apply button should be visible` |
| Other | `Take a screenshot "Orders"`, `Scroll to the bottom`, `Refresh the page`, `Go back`, `Log in` (already done) |

Controls are found by what they're called on screen: accessible name, label,
placeholder, text, column header or legend name; a kind word (button, link, tab,
column) narrows it. The baseline resolves each step; the candidate then acts on the
control with the same role and name. `{{username}}`, `{{password}}` and `{{totp}}`
are the logged-in user's; `{{env.NAME}}` reads an environment variable. Passwords,
codes and `{{env.…}}` values are shown as `••••` in the report. With `--ai`, a step
that doesn't read as any of these, or whose target isn't found, is worked out by the
AI provider against the page's controls.

Besides failures (`journey.step-failed`), a step that changes the page on the
baseline and does nothing on the candidate is reported (`journey.no-effect`), and so
are tooltips that differ while hovering (`journey.tooltip`, `journey.tooltip-missing`).

### Steps

Used by `journeys` and `auth.steps`. A **locator** is a Playwright selector string
(`"#email"`, `"text=Sign in"`) or an object: `{ role, name }`, `{ label }`,
`{ text }`, `{ testId }`, `{ placeholder }`, `{ title }`, `{ alt }`,
`{ selector }` — each with optional `exact: true` and `nth: 2`.

| Step | Example |
|---|---|
| `goto` | `goto: /products/1` |
| `click`, `dblclick`, `hover`, `focus`, `check`, `uncheck` | `click: { role: button, name: Add to cart }` |
| `fill` (replace) / `type` (key by key) | `fill: { label: Email, value: "${QA_USER}" }` |
| `press` | `press: Enter` or `press: { selector: "#q", key: Enter }` |
| `select` | `select: { label: Country, option: Germany }` (or `value:`, `index:`) |
| `scroll` | `scroll: bottom`, `scroll: top`, or a locator |
| `wait` | `wait: 500` (ms) |
| `waitFor` | `waitFor: ".results"` (visible) |
| `waitForUrl` / `expectUrl` | `waitForUrl: "**/cart"` |
| `expectVisible` / `expectHidden` | `expectVisible: { text: Order confirmed }` |
| `expectText` | `expectText: { selector: h1, text: Your cart }` (contains) |
| `screenshot` | `screenshot: Cart` — a named visual checkpoint |
| `evaluate` | `evaluate: "localStorage.clear()"` |

Any step can also take `label:` (shown in the report) and `timeout:` (ms).

## `report`

| Key | Default | |
|---|---|---|
| `outDir` | `envdiff-report` | Reused between runs: envdiff only removes its own files there. |
| `failOn` | `critical` | Exit 1 when a finding at or above this exists: `critical`, `major`, `minor`, `never`. |
| `screenshots` | `changes` | Interaction screenshots to keep: `changes` (where the sides behaved differently) or `all`. Page screenshots are always kept. |
| `title` | "baseline vs candidate" | |

## `ai`

| Key | Default | |
|---|---|---|
| `enabled` | `false` | `--ai`. Triage of findings, and help with journey steps. Sends screenshots and findings to the provider. |
| `provider` | `auto` | `anthropic` (Claude; `ANTHROPIC_API_KEY`), `copilot` (GitHub Copilot as the signed-in GitHub user: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` — in Actions the job needs `permissions: copilot-requests: write`; a fine-grained personal access token with the "Copilot Requests" permission uses that person's Copilot — or a `copilot login` session; needs `npm install @github/copilot-sdk`), or `auto`: Anthropic when its key is set, otherwise Copilot. `--ai-provider`. |
| `model` | provider's | `claude-opus-5-5` for Anthropic; Copilot's automatic choice (`auto`) for Copilot, or any model your Copilot plan offers. |
| `effort` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`. |
| `maxItems` | `25` | Pages/journeys triaged, worst first. |
| `minSeverity` | `minor` | Findings below this aren't sent. |

## Run

| Key | Default | |
|---|---|---|
| `concurrency` | `2` | Pages processed in parallel (each uses one tab per environment). |
| `timeouts.navigation` | `30000` | ms per page load. |
| `timeouts.total` | 45 min | Stop starting new pages after this and report what was done (`--timeout <minutes>`). |

## Finding types

| Category | Types |
|---|---|
| availability | `page.unavailable`, `page.redirect`, `page.broken-both`, `page.fixed` |
| interaction | `interaction.failed`, `interaction.no-effect`, `interaction.no-update`, `interaction.no-toggle`, `interaction.no-navigation`, `interaction.unexpected-navigation`, `interaction.nav-target`, `interaction.nav-data`, `interaction.dialog`, `interaction.popup`, `interaction.download`, `interaction.alert`, `interaction.alert-text`, `interaction.missing-call`, `interaction.error-text`, `interaction.new-effect`, `interaction.visual` |
| errors | `errors.uncaught`, `errors.console` |
| network | `network.failed`, `network.failed-asset`, `images.broken` |
| api | `api.field-missing`, `api.type-changed`, `api.field-added`, `interaction.payload` |
| elements | `elements.missing`, `elements.mostly-missing`, `elements.disabled`, `elements.options`, `elements.new`, `elements.data-links` |
| forms | `forms.missing`, `forms.field-missing`, `forms.validation`, `forms.attribute` |
| content | `content.text`, `content.suspicious`, `elements.label` |
| links | `links.broken`, `links.broken-new`, `elements.href` |
| visual / layout | `visual.diff`, `layout.shift`, `layout.moved`, `layout.style`, `layout.overflow` |
| journey | `journey.step-failed`, `journey.diverged`, `journey.baseline-failed`, `journey.no-effect`, `journey.tooltip`, `journey.tooltip-missing`, `journey.visual` |
| data | `grid.missing`, `grid.added`, `grid.loading`, `grid.empty`, `grid.row-count`, `grid.column-missing`, `grid.column-added`, `grid.column-renamed`, `grid.column-order`, `grid.column-empty`, `grid.cell-errors`, `grid.format`, `grid.sort`, `grid.paging`, `grid.values`, `chart.missing`, `chart.added`, `chart.no-data`, `chart.title`, `chart.series-missing`, `chart.series-added`, `chart.series-type`, `chart.series-hidden`, `chart.series-empty`, `chart.points`, `chart.axis`, `chart.categories`, `chart.menu`, `chart.tooltip`, `chart.tooltip-missing`, `chart.tooltip-new` |
| a11y | `a11y.<axe rule id>` |
| perf, seo, security | `perf.slower`, `seo.title`, `seo.noindex`, `seo.canonical`, `seo.lang`, `security.header` |
