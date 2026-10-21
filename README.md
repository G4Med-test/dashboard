# G4Med dashboard

Static GitHub Pages site showing every G4Med test that uses
`G4Med-test/ci-workflows/.github/workflows/pipeline.yml`:

- **Overview** (`index.html`): what is running and on which job, result and duration of
  the last run, Geant4 version, publication to `validation-results`, open pull requests and
  where they stand in the approval flow, recent history. Click a test for its page.
- **Test page** (`test.html?t=<name>`): links to the repository, Actions, pull requests and
  the test's folder in `validation-results`; open pull requests with an *Opened → GitHub
  checks → Approval → Padova & validation* tracker and the button to approve or follow the
  run; duration chart; every run (filterable) with stage bar, scope, Geant4 version and
  publication; every publication to `validation-results`.

## How it works

```text
cron every 10 min ──► update.yml ──► scripts/collect.py ──► site/data.json + site/tests/<name>.json ──► Pages
                                     │                       site/*.html read the JSON (reload every 60 s)
                                     ├─ GitHub API (runs, jobs, PRs, pending deployments)
                                     ├─ clone of validation-results (publications + provenance.json)
                                     └─ actions/cache with the details of completed runs
```

No token reaches the browser and nothing is committed: the JSON travels in the Pages
artifact. Completed runs are cached, so after the first updates each one costs about
3 API calls per test plus 3–4 per running run. The first time, at most
`MAX_DETAIL_FETCHES` (150) old runs are indexed per update and the footer says how many
are still pending.

| Shown | Source |
| --- | --- |
| Tests | repos of the org whose `.github/workflows/ci.yml` calls `pipeline.yml` (or `ci-workflows/tests.json`, if present) |
| Stage bar | jobs of the run: build · unit test (GitHub) · unit test (Padova) · validation · collect JSON · publish results; hover for durations |
| Scope | *Full pipeline* if any Padova job started, else *GitHub checks only* |
| Geant4 | `Geant4 <version>` annotation of the build job (see below), otherwise `provenance.json` of the matching publication |
| Published | commit of `validation-results/<test>/` whose `provenance.json` points to the run's commit |
| Overview status | last non-PR run; pull-request runs are shown in the *Pull requests* column |

## Approval gate

The dashboard recognises both usual ways of gating the Padova jobs, and the button it shows
matches the one in use:

| Pull request state | When | Button |
| --- | --- | --- |
| Waiting for CI | no run for the PR head yet | — |
| GitHub checks running / failed | build or GitHub unit test running / failed | View run / View failure |
| **Awaiting approval** (merge) | run finished, build and GitHub unit test passed, Padova jobs skipped | **Review & merge** (PR *Files* tab) |
| **Awaiting approval** (environment) | run in *Waiting* with a pending deployment, or a first-time contributor's run needing *Approve and run* | **Approve run** (run page with *Review deployments*) |
| Approved · running / finished | Padova jobs started / finished | View run |

**A. Merging is the approval.** In `pipeline.yml`, give the Padova jobs
`if: github.event_name != 'pull_request'`. PR runs stop after the GitHub unit test; the
merge to `main` starts the full pipeline.

**B. A reviewer approves the run, without merging.** Create an environment (e.g. `padova`)
with *Required reviewers* in each test repository and put `environment: padova` on the
`unit-test-padova` job; validation already waits for it, so one approval releases
everything. Keep `publish-results` for the default branch
(`if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`), so a
PR never overwrites the published results.

In both cases the reviewer is approving code that will run on the Padova self-hosted
runner: the PR diff is what needs reviewing.

## Setup

1. Create `G4Med-test/dashboard` with these files.
2. *Settings → Pages → Source: **GitHub Actions***.
3. Public test repositories need nothing more. For private ones add the secret
   **`DASHBOARD_TOKEN`**: fine-grained, owner `G4Med-test`, access to the test repositories
   and `validation-results`, read-only *Actions*, *Contents*, *Pull requests*,
   *Deployments* and *Metadata*.
4. Apply `ci-workflows-geant4-version.patch` to `ci-workflows`: the build job then records
   `geant4-config --version` as an annotation. Without it the version is known only for
   runs whose results were published.
5. Start *Actions → Update dashboard → Run workflow* once.

## Manual update

**↻ Update now**, at the top right of both pages, starts `update.yml` without waiting for
the cron:

- **Without a token** it opens *Actions → Update dashboard* on GitHub, where anyone with
  write access to this repository clicks *Run workflow*.
- **With a token** saved in the browser (⚙ next to the button) it starts the run itself,
  in one click. See below.

Every run of the workflow, scheduled or manual, shows a progress bar with the current step
and the time left, estimated from the step durations of the last passed run. When the run
passes, the page waits for the new `data.json` and reloads the data. Without a token the
page uses GitHub's unauthenticated API, 60 calls per hour shared by everyone behind the same
IP address: it checks for runs every 5 minutes and follows one every 15 s (with a token, 30 s
and 4 s). If the limit is reached the page says so and resumes when it resets.

### Token for one-click updates

Needed only to start updates from the page; anyone can watch the progress without one. You
need write access to `G4Med-test/dashboard` (or to ask an organization owner to approve the
token, if the organization requires it).

1. Open <https://github.com/settings/personal-access-tokens/new> (*Settings → Developer
   settings → Personal access tokens → Fine-grained tokens → Generate new token*).
2. *Token name*: e.g. `dashboard update`. *Expiration*: your choice (when it expires the
   page says the token was rejected: create a new one).
3. *Resource owner*: **`G4Med-test`**.
4. *Repository access*: **Only select repositories → `dashboard`**.
5. *Permissions → Repository permissions → Actions*: **Read and write** (*Metadata: Read*
   is added automatically). Nothing else.
6. *Generate token*, copy it (`github_pat_…`).
7. On the dashboard click **⚙**, paste it, **Save**. The icon turns green; ⚙ again to change
   or remove it.

The token is kept only in that browser's `localStorage` and sent only to `api.github.com`.
Every Pages site of the organization can read that storage (they all live on
`g4med-test.github.io`), so give the token that single permission and nothing more.

## Notes

- **Scheduled workflows are disabled after 60 days** without activity in a public
  repository. To avoid it, and to refresh the page as soon as a pipeline ends, add a last
  job to `pipeline.yml` (`if: always()`) running
  `gh workflow run update.yml -R G4Med-test/dashboard` with the existing
  `G4MED_DISPATCH_TOKEN` (with *Actions: write* on `dashboard` too), passed from each
  test's `ci.yml`, e.g. with `secrets: inherit`.
- GitHub's cron is not punctual: 5–15 minute delays are normal. The page shows the age of
  the data and turns orange after 30 minutes.
- Local preview: `GITHUB_TOKEN=$(gh auth token) RESULTS_DIR=../validation-results
  python3 scripts/collect.py && python3 -m http.server -d site`.
