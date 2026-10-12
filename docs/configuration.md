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

Command line: positional arguments, `--baseline-label`, `--baseline-header`,
`--baseline-auth`, `--baseline-storage` (and `candidate-…`, or unprefixed for both).
Environment: `ENVDIFF_HEADERS`, `ENVDIFF_BASELINE_HEADERS`, `ENVDIFF_CANDIDATE_HEADERS`
("Name: value" per line, or separated by `;;`), `ENVDIFF_AUTH`,
`ENVDIFF_BASELINE_AUTH`, `ENVDIFF_CANDIDATE_AUTH` ("user:password").

## `auth`

Runs once per environment before anything is compared, with writes allowed (a login
form is a POST). The session is reused for every page and viewport.

| Key | |
|---|---|
| `loginUrl` | Path or URL to open first (default: the environment's URL). |
| `steps` | List of [steps](#steps). |
| `successUrl` | Glob the URL must match afterwards, e.g. `"**/dashboard**"`. |
| `successSelector` | Element that must be visible afterwards. |

A failed login stops the run (exit 2) and saves `login-failed-<side>.png` in the
report directory.

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
| `selects` | `true` | Exercise dropdowns by picking an option that exists on both sides. |
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

## `stabilize`

When a page counts as "ready": no network activity and no DOM changes for `quietMs`.

| Key | Default | |
|---|---|---|
| `quietMs` | `400` | |
| `maxWaitMs` | `10000` | Give up waiting after this long and use the page as it is. |
| `ignoreMutations` | `[]` | Selectors whose changes don't count (carousels, tickers, clocks). |
| `scroll` | `true` | Scroll through each page so lazy content loads before the full-page screenshot. |
| `dismissConsent` | `true` | Click "Accept" on common cookie banners (OneTrust, Cookiebot, Didomi, Usercentrics…). |

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
| `requests` | Request URL regexes to ignore (failures and API shapes). Common analytics, ads and session-replay hosts are ignored already. |
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

Journeys start at the first start path unless their first step is a `goto`.

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
| `enabled` | `false` | `--ai`. Needs `ANTHROPIC_API_KEY`. Sends screenshots and findings to the Anthropic API. |
| `model` | `claude-opus-5-5` | |
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
| journey | `journey.step-failed`, `journey.diverged`, `journey.baseline-failed`, `journey.visual` |
| a11y | `a11y.<axe rule id>` |
| perf, seo, security | `perf.slower`, `seo.title`, `seo.noindex`, `seo.canonical`, `seo.lang`, `security.header` |
