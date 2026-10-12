---
name: envdiff
description: Compare two environments or branches of a web app (UAT vs PROD, DEV vs UAT, a PR preview vs production, branch vs branch) with envdiff, then verify and explain what the new code broke. Use when asked to compare environments, check a deployment or release candidate for regressions, QA a preview, or read an envdiff report.
---

# Comparing environments with envdiff

envdiff loads the same pages in two environments, clicks every safe control in
both, and reports differences as findings (critical / major / minor / info) with
screenshot evidence. Your job: run it well, then separate real regressions from
expected differences, and report clearly.

## 1. Decide what to compare

- **Baseline** = the known-good side (production, UAT). **Candidate** = the new code.
  If the user names them the other way round, swap them and say so.
- Inputs are URLs or branch names. Branches need a preview URL pattern
  (`--url-template "https://{branch}--site.netlify.app"`) or a `branches.serve`
  config that builds them locally (see `examples/branches.config.yaml`).
- Ask before using `--allow-mutations` (lets clicks POST/PUT/PATCH/DELETE), and
  never use it against production.

## 2. Run it

Inside the envdiff repository, use `node bin/envdiff.js`; elsewhere, `envdiff` if it
is on the PATH. First run needs `npm ci` and `npx playwright install chromium`.

```bash
envdiff <baseline> <candidate> --out envdiff-report --viewports desktop,mobile --json
```

- Focus a question ("is checkout broken?") with `--paths /cart,/checkout --max-pages 6 --click-depth 2`.
- Logged-in apps: an `auth:` section in a config file (credentials from env vars),
  `--candidate-storage auth.json`, or `--candidate-auth user:pass`. Secrets go in
  environment variables (`ENVDIFF_CANDIDATE_AUTH`, `ENVDIFF_CANDIDATE_HEADERS`), never
  inline in commands you show the user.
- Exit code 2 means it couldn't run (unreachable URL, bad config, failed login):
  read the message and fix that first.
- A full run takes minutes; use a narrow one to iterate, a broad one to finish.

## 3. Read `envdiff-report/report.json`

- `summary`: verdict, counts, pages and interactions compared.
- `findings[]`: `severity`, `type`, `title`, `detail`, `page`, `viewport`,
  `element`, `baseline` / `candidate` values, `evidence` (screenshot paths relative
  to the report directory), `id`.
- `pages[].interactions[]`: every click, with what it did on each side and a verdict.
- `api[]`: JSON endpoints seen and their statuses per side.

Work from critical down. For each finding that matters, **look at the evidence**:
open the `evidence.baseline` / `evidence.candidate` / `evidence.diff` images with the
Read tool before concluding. Screenshots settle most "regression or not" questions.

## 4. Judge each finding

- **Regression**: errors after a click, dead controls, missing features, 4xx/5xx,
  dropped API fields, `NaN`/`undefined` on screen, broken layout on mobile.
- **Intended change**: new copy, restyled or moved elements, new features — confirm
  with the user or the PR description if unsure.
- **Environment difference**: different data (product lists, counts), feature flags,
  slower non-production servers, missing third-party keys.
- **Noise**: clocks, rotating banners, ads. Fix with `--mask <selector>` or
  `ignore.text`, then re-run.

If the candidate's source is available, trace serious regressions to code (the
exception message, the failing endpoint, the missing control's component).

## 5. Report back

Lead with the verdict in one sentence (safe to promote or not), then:

1. Regressions, worst first: page, what happens, how to reproduce, evidence.
2. Probably intended changes worth a human look.
3. Environment differences and noise, briefly, with the config that would silence
   them (`visual.mask`, `ignore.text`, or the finding ids for `ignore.findings`).

Point to `envdiff-report/index.html` for the full interactive report.
