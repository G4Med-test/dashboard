#!/usr/bin/env python3
"""Collect the status of every G4Med test pipeline for the dashboard.

Writes:
  <OUTPUT_DIR>/data.json          overview of every test (index page)
  <OUTPUT_DIR>/tests/<name>.json  every run, open pull request and publication of one test

Sources:
  - GitHub REST API: the org's repositories, each test's ci.yml runs and jobs, open pull
    requests, pending deployments, and the build-job annotation with the Geant4 version;
  - a local clone of G4Med-test/validation-results (full history): when each test's
    results were published, from which commit and with which Geant4 version.

Details of completed runs never change, so they are kept in CACHE_FILE between updates
and only new runs cost API calls (at most MAX_DETAIL_FETCHES per update).

Only the standard library is used. Environment:
  GITHUB_TOKEN         API token (the Actions GITHUB_TOKEN is enough for public repos)
  ORG                  organization (default G4Med-test)
  RESULTS_DIR          clone of validation-results (default ./validation-results)
  OUTPUT_DIR           output directory (default ./site)
  CACHE_FILE           run-detail cache (default ./cache/runs.json)
  RUNS_PER_TEST        runs kept per test (default 100)
  MAX_DETAIL_FETCHES   new completed runs detailed per update (default 150)
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.github.com"
ORG = os.environ.get("ORG", "G4Med-test")
TOKEN = os.environ.get("GITHUB_TOKEN", "")
RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", "validation-results"))
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "site"))
CACHE_FILE = Path(os.environ.get("CACHE_FILE", "cache/runs.json"))
RUNS_PER_TEST = int(os.environ.get("RUNS_PER_TEST", "100"))
MAX_DETAIL_FETCHES = int(os.environ.get("MAX_DETAIL_FETCHES", "150"))
OVERVIEW_HISTORY = 15

PIPELINE_REF = f"{ORG}/ci-workflows/.github/workflows/pipeline.yml"
EXCLUDE = {"ci-workflows", "validation-results", "geant4-alma9", "template", "dashboard", ".github"}
WORKFLOW_FILE = "ci.yml"
VERSION_ANNOTATION = re.compile(r"^Geant4\s+(\S+)$")

# Pipeline stages in order; the first group runs on GitHub, the second needs approval.
STAGES = ["build", "unit-test", "unit-test-padova", "run-macro", "collect-json", "publish-results"]
GITHUB_STAGES = {"build", "unit-test"}
GATED_STAGES = {"unit-test-padova", "get-macros", "run-macro", "collect-json", "publish-results"}
BAD = {"failure", "cancelled", "timed_out", "startup_failure"}
ACTIVE = {"in_progress", "queued", "waiting", "pending", "requested"}

calls = 0
detail_budget = MAX_DETAIL_FETCHES
undetailed = 0  # completed runs left without details because the budget ran out


# ------------------------------------------------------------------------------ API

def api(path, params=None, raw=False):
    """GET an API path; parsed JSON (or text if raw), None on 404/409."""
    global calls
    url = path if path.startswith("http") else API + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github.raw" if raw else "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "g4med-dashboard",
        **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
    })
    calls += 1
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
    except urllib.error.HTTPError as err:
        if err.code in (404, 409):
            return None
        raise
    return body if raw else json.loads(body)


def api_pages(path, key=None, limit=1000, params=None):
    items, page = [], 1
    while len(items) < limit:
        data = api(path, {"per_page": 100, "page": page, **(params or {})})
        if data is None:
            break
        chunk = data[key] if key else data
        items.extend(chunk)
        if len(chunk) < 100:
            break
        page += 1
    return items[:limit]


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def seconds_between(start, end):
    s, e = parse_time(start), parse_time(end)
    return max(0, int((e - s).total_seconds())) if s and e else None


# ----------------------------------------------------------------------- discovery

def discover_tests():
    """Repositories listed in ci-workflows/tests.json, else those whose ci.yml calls the pipeline."""
    listed = api(f"/repos/{ORG}/ci-workflows/contents/tests.json", raw=True)
    if listed:
        names = [t["repo"].split("/", 1)[1] for t in json.loads(listed)["tests"]]
        return [r for r in (api(f"/repos/{ORG}/{n}") for n in names) if r]
    tests = []
    for repo in api_pages(f"/orgs/{ORG}/repos"):
        if repo["name"] in EXCLUDE or repo["archived"]:
            continue
        ci = api(f"/repos/{ORG}/{repo['name']}/contents/.github/workflows/{WORKFLOW_FILE}", raw=True)
        if ci and PIPELINE_REF in ci:
            tests.append(repo)
    return sorted(tests, key=lambda r: r["name"].lower())


# ---------------------------------------------------------------------------- runs

def classify_job(name):
    """Pipeline stage of a job, from the name GitHub gives jobs of reusable workflows."""
    n = name.lower()
    for stage in ("publish-results", "collect-json", "run-macro", "get-macros",
                  "unit-test-padova", "unit-test", "index", "build"):
        if stage in n:
            return "build" if stage == "index" else stage
    return "other"


def worst(states):
    order = ["failure", "timed_out", "startup_failure", "cancelled", "in_progress", "waiting",
             "queued", "pending", "action_required", "success", "neutral", "skipped"]
    return min(states, key=lambda s: order.index(s) if s in order else len(order))


def job_details(full, run):
    """Stages, scope, current job and Geant4 version of one run (3-4 API calls)."""
    jobs = api_pages(f"/repos/{full}/actions/runs/{run['id']}/jobs", key="jobs")
    by_stage = {}
    for job in jobs:
        by_stage.setdefault(classify_job(job["name"]), []).append(job)
    stages = {}
    for stage, js in by_stage.items():
        if stage == "other":
            continue
        starts = [j["started_at"] for j in js if j.get("started_at") and j["conclusion"] != "skipped"]
        ends = [j["completed_at"] for j in js if j.get("completed_at") and j["conclusion"] != "skipped"]
        stages[stage] = {
            "state": worst([j["conclusion"] or j["status"] for j in js]),
            "jobs": len(js),
            "duration_s": seconds_between(min(starts), max(ends)) if starts and ends else None,
        }
    running = [j for j in jobs if j["status"] == "in_progress"]
    current = None
    if running:
        job = running[0]
        step = next((s["name"] for s in job.get("steps", []) if s["status"] == "in_progress"), None)
        current = {"job": job["name"].split(" / ")[-1], "step": step, "started_at": job["started_at"],
                   "runner": job.get("runner_name"), "parallel": len(running)}

    geant4 = None
    for job in by_stage.get("build", []):
        if job["conclusion"] != "success" or "index" in job["name"].lower():
            continue
        for ann in api(f"/repos/{full}/check-runs/{job['id']}/annotations") or []:
            m = VERSION_ANNOTATION.match((ann.get("title") or "").strip())
            if m:
                geant4 = m.group(1)
                break
        if geant4:
            break

    # "full" once a gated job has actually started: queued/waiting ones are still behind the gate.
    not_started = (None, "skipped", "queued", "pending", "waiting", "requested")
    gated_ran = any(stages.get(s, {}).get("state") not in not_started for s in GATED_STAGES)
    return {"stages": stages, "current": current, "geant4": geant4,
            "scope": "full" if gated_ran else "github"}


def pending_deployments(full, run_id):
    """Environments waiting for a reviewer on a run (environment protection rules)."""
    pend = api(f"/repos/{full}/actions/runs/{run_id}/pending_deployments") or []
    return [{"environment": p["environment"]["name"],
             "reviewers": [(r.get("reviewer") or {}).get("login") or (r.get("reviewer") or {}).get("name")
                           for r in p.get("reviewers", [])]} for p in pend]


def run_record(full, r, cache):
    global detail_budget, undetailed
    rec = {
        "id": r["id"], "attempt": r["run_attempt"], "url": r["html_url"],
        "status": r["status"], "conclusion": r["conclusion"], "event": r["event"],
        "branch": r["head_branch"], "sha": r["head_sha"], "title": r["display_title"],
        "actor": (r.get("triggering_actor") or r.get("actor") or {}).get("login"),
        "prs": [p["number"] for p in r.get("pull_requests") or []],
        "started_at": r["run_started_at"], "updated_at": r["updated_at"],
        "duration_s": seconds_between(r["run_started_at"], r["updated_at"]) if r["status"] == "completed" else None,
    }
    key = f"{full}/{r['id']}/{r['run_attempt']}"
    if r["status"] == "completed" and key in cache:
        rec.update(cache[key])
    elif r["status"] != "completed" or detail_budget > 0:
        if r["status"] == "completed":
            detail_budget -= 1
        rec.update(job_details(full, r))
        if r["status"] == "completed":
            cache[key] = {k: rec[k] for k in ("stages", "geant4", "scope")}
        if r["status"] == "waiting":
            rec["pending"] = pending_deployments(full, r["id"])
    else:
        undetailed += 1
    rec["publish"] = publish_state(rec)
    return rec, key


def publish_state(rec):
    st = (rec.get("stages") or {}).get("publish-results", {}).get("state")
    if "stages" not in rec:
        return None  # details not fetched yet
    if st and st != "skipped":
        return st
    if rec["status"] != "completed":
        return "pending"
    return "not_run"


# --------------------------------------------------------------- pull requests

def pr_status(pr, runs):
    """Where an open pull request stands in the gated pipeline, and what to click."""
    run = next((r for r in runs if pr["number"] in r["prs"] or r["sha"] == pr["head_sha"]), None)
    base = {"run": {k: run[k] for k in ("id", "url", "status", "conclusion", "started_at", "duration_s")}
            if run else None}
    if run is None:
        return {**base, "state": "no_ci", "action": None}
    stages = run.get("stages") or {}
    gh_states = [stages[s]["state"] for s in GITHUB_STAGES if s in stages]
    if run["status"] == "waiting" or run["conclusion"] == "action_required":
        # Environment protection rule, or first-time-contributor approval: both on the run page.
        return {**base, "state": "awaiting_approval", "pending": run.get("pending", []),
                "action": {"label": "Approve run", "url": run["url"]}}
    if run["status"] != "completed":
        if run.get("scope") == "full":
            return {**base, "state": "running", "action": {"label": "View run", "url": run["url"]}}
        return {**base, "state": "checks_running", "action": {"label": "View run", "url": run["url"]}}
    if any(s in BAD for s in gh_states) or (run["conclusion"] in BAD and run.get("scope") != "full"):
        return {**base, "state": "checks_failed", "action": {"label": "View failure", "url": run["url"]}}
    if run.get("scope") == "full":
        return {**base, "state": "completed", "action": {"label": "View run", "url": run["url"]}}
    # GitHub checks passed, gated jobs skipped: approval means reviewing and merging the PR.
    return {**base, "state": "awaiting_approval", "pending": [],
            "action": {"label": "Review & merge", "url": pr["url"] + "/files"}}


def open_prs(full, runs):
    out = []
    for pr in api(f"/repos/{full}/pulls", {"state": "open", "per_page": 50}) or []:
        rec = {"number": pr["number"], "title": pr["title"], "url": pr["html_url"],
               "author": pr["user"]["login"], "draft": pr.get("draft", False),
               "created_at": pr["created_at"], "updated_at": pr["updated_at"],
               "head": pr["head"]["ref"], "head_sha": pr["head"]["sha"],
               "from_fork": (pr["head"].get("repo") or {}).get("full_name") != full}
        rec.update(pr_status(rec, runs))
        out.append(rec)
    return out


# -------------------------------------------------------- validation-results

def git(*args):
    return subprocess.run(["git", "-C", str(RESULTS_DIR), *args], capture_output=True, text=True).stdout


def read_publications():
    """Per test directory, every commit that changed it, newest first, with provenance."""
    out = {}
    if not RESULTS_DIR.is_dir():
        print(f"warning: {RESULTS_DIR} not found, publication info skipped", file=sys.stderr)
        return out, None
    remote = git("remote", "get-url", "origin").strip().removesuffix(".git")
    remote = remote if remote.startswith("http") else f"https://github.com/{ORG}/validation-results"
    for d in sorted(p for p in RESULTS_DIR.iterdir() if p.is_dir() and not p.name.startswith(".")):
        pubs = []
        for line in git("log", "--format=%H%x09%cI%x09%s", "--", d.name).splitlines():
            commit, date, subject = line.split("\t", 2)
            prov = {}
            try:
                prov = json.loads(git("show", f"{commit}:{d.name}/provenance.json") or "{}")
            except ValueError:
                pass
            pubs.append({"commit": commit, "date": date, "subject": subject,
                         "commit_url": f"{remote}/commit/{commit}",
                         "sha": (prov.get("test_repo") or {}).get("sha"),
                         "geant4_version": prov.get("geant4_version")})
        if not pubs:
            continue
        latest = pubs[0]
        try:
            latest["plots"] = len(json.loads((d / "results.json").read_text()))
        except (OSError, ValueError):
            latest["plots"] = None
        prov = json.loads((d / "provenance.json").read_text()) if (d / "provenance.json").exists() else {}
        latest["geant4_commit"] = (prov.get("container_repo") or {}).get("geant4_commit")
        latest["image"] = prov.get("image")
        out[d.name] = {"folder_url": f"{remote}/tree/HEAD/{d.name}", "latest": latest, "history": pubs}
    return out, remote


# ------------------------------------------------------------------------ tests

def collect_test(repo, publications, cache, used_keys):
    full = repo["full_name"]
    raw = api_pages(f"/repos/{full}/actions/workflows/{WORKFLOW_FILE}/runs", key="workflow_runs",
                    limit=RUNS_PER_TEST) if RUNS_PER_TEST else []
    runs = []
    for r in raw:
        rec, key = run_record(full, r, cache)
        used_keys.add(key)
        runs.append(rec)

    pub = publications.get(repo["name"])
    by_sha = {}
    for p in (pub or {}).get("history", []):
        by_sha.setdefault(p["sha"], p)  # newest publication of that commit
    for rec in runs:
        if rec.get("geant4"):
            rec["geant4_source"] = "build"
        p = by_sha.get(rec["sha"])
        if p and rec["status"] == "completed" and rec.get("publish") == "success":
            rec["published"] = {"date": p["date"], "commit_url": p["commit_url"]}
            if not rec.get("geant4") and p["geant4_version"]:
                rec["geant4"], rec["geant4_source"] = p["geant4_version"], "provenance"

    prs = open_prs(full, runs)
    links = {
        "repo": repo["html_url"],
        "actions": f"{repo['html_url']}/actions/workflows/{WORKFLOW_FILE}",
        "pulls": f"{repo['html_url']}/pulls",
        "results": pub["folder_url"] if pub else None,
    }
    # The main-line status ignores pull-request runs: those are tracked as PRs.
    main_runs = [r for r in runs if r["event"] != "pull_request"]
    last_completed = next((r for r in main_runs if r["status"] == "completed"), None)
    summary = {
        "name": repo["name"], "description": repo.get("description"), "private": repo["private"],
        "default_branch": repo["default_branch"], "links": links,
        "running": [r for r in main_runs if r["status"] != "completed"],
        "last_completed": last_completed,
        "history": [{k: r.get(k) for k in ("id", "url", "status", "conclusion", "started_at", "duration_s", "event", "scope")}
                    for r in runs[:OVERVIEW_HISTORY]],
        "prs": prs,
        "published": pub["latest"] if pub else None,
        "runs_total": len(runs),
    }
    detail = {**{k: summary[k] for k in ("name", "description", "private", "default_branch", "links", "prs")},
              "runs": runs, "publications": (pub or {}).get("history", [])}
    return summary, detail


def main():
    cache = {}
    if CACHE_FILE.exists():
        try:
            cache = json.loads(CACHE_FILE.read_text())
        except ValueError:
            pass
    publications, results_url = read_publications()
    used_keys, summaries = set(), []
    (OUTPUT_DIR / "tests").mkdir(parents=True, exist_ok=True)
    for repo in discover_tests():
        summary, detail = collect_test(repo, publications, cache, used_keys)
        summaries.append(summary)
        (OUTPUT_DIR / "tests" / f"{repo['name']}.json").write_text(json.dumps(detail, indent=1) + "\n")

    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "org": ORG,
        "results_repo": results_url or f"https://github.com/{ORG}/validation-results",
        "tests": summaries,
        "orphan_results": sorted(set(publications) - {t["name"] for t in summaries}),
        "undetailed_runs": undetailed,
        "api_calls": calls,
    }
    (OUTPUT_DIR / "data.json").write_text(json.dumps(data, indent=1) + "\n")
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps({k: v for k, v in cache.items() if k in used_keys}))
    print(f"{len(summaries)} tests, {calls} API calls, {MAX_DETAIL_FETCHES - detail_budget} runs detailed")


if __name__ == "__main__":
    main()
