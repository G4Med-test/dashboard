// Helpers shared by index.html and test.html.

const STAGES = [["build", "Build"], ["unit-test", "Unit test (GitHub)"], ["unit-test-padova", "Unit test (Padova)"],
                ["run-macro", "Validation"], ["collect-json", "Collect JSON"], ["publish-results", "Publish results"]];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));

function fmtDur(s) {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m`;
}
const fmtDate = d => d ? new Date(d).toLocaleString("en-GB", {day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"}) : "—";
const fullDate = d => d ? new Date(d).toLocaleString("en-GB") : "";

function ago(d) {
  if (!d) return "—";
  const s = Math.round((Date.now() - new Date(d)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
const since = d => fmtDur(Math.max(0, Math.round((Date.now() - new Date(d)) / 1000)));

const cls = st => ({success: "ok", failure: "bad", cancelled: "bad", timed_out: "bad", startup_failure: "bad",
  in_progress: "run", queued: "run", pending: "run", requested: "run",
  waiting: "gate", action_required: "gate"}[st] || "idle");

const label = st => ({success: "Passed", failure: "Failed", cancelled: "Cancelled", timed_out: "Timed out",
  startup_failure: "Startup failure", in_progress: "Running", queued: "Queued", waiting: "Awaiting approval",
  pending: "Pending", requested: "Requested", skipped: "Skipped", neutral: "Neutral", not_run: "Not run",
  action_required: "Awaiting approval", completed: "Completed"}[st] || st || "—");

const runState = r => r.status === "completed" ? r.conclusion : r.status;

function stagesBar(stages) {
  if (!stages) return "";
  return `<div class="stages">${STAGES.map(([k, name]) => {
    const s = stages[k], st = s?.state, c = cls(st);
    const css = st === "skipped" ? "s-skip" : {ok: "s-ok", bad: "s-bad", run: "s-run", gate: "s-gate"}[c] || "";
    const tip = `${name}: ${label(st || "not_run")}${s?.duration_s != null ? " · " + fmtDur(s.duration_s) : ""}${s?.jobs > 1 ? ` · ${s.jobs} jobs` : ""}`;
    return `<span class="stage ${css}" title="${esc(tip)}"></span>`;
  }).join("")}</div>`;
}

const scopeLabel = s => s === "github" ? "GitHub checks only" : s === "full" ? "Full pipeline" : "—";

// Pull-request states produced by collect.py (pr_status).
const PR_STATES = {
  no_ci:             {css: "idle", text: "Waiting for CI"},
  checks_running:    {css: "run",  text: "GitHub checks running"},
  checks_failed:     {css: "bad",  text: "GitHub checks failed"},
  awaiting_approval: {css: "gate", text: "Awaiting approval"},
  running:           {css: "run",  text: "Approved · running"},
  completed:         {css: "ok",   text: "Approved · finished"},
};
function prPill(pr) {
  const s = PR_STATES[pr.state] || {css: "idle", text: pr.state};
  let css = s.css, text = s.text;
  if (pr.state === "completed" && pr.run && pr.run.conclusion !== "success") { css = "bad"; text = "Approved · failed"; }
  return `<span class="pill ${css}">${esc(text)}</span>`;
}

function prAction(pr, small) {
  if (!pr.action) return "";
  const primary = pr.state === "awaiting_approval";
  return `<a class="${small ? "" : "btn "}${primary && !small ? "primary" : ""}" href="${esc(pr.action.url)}" target="_blank" rel="noopener">${esc(pr.action.label)} ↗</a>`;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function setUpdated(el, generatedAt) {
  el.textContent = `Data updated ${ago(generatedAt)} (${fmtDate(generatedAt)})`;
  el.classList.toggle("stale", (Date.now() - new Date(generatedAt)) / 60000 > 30);
}

async function getJSON(path) {
  const r = await fetch(`${path}?t=${Date.now()}`, {cache: "no-store"});
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// "Update now" button and progress bar of update.yml (see README, "Manual update").
// Without a token the button opens the workflow on GitHub, where a maintainer clicks
// "Run workflow"; with a token saved in this browser it starts the run itself. Any run of
// the workflow, scheduled ones too, is followed until the new data.json is online.

const WORKFLOW = "update.yml";
const TOKEN_KEY = "g4med-dashboard-token";
const local = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};

// Unauthenticated calls share 60 per hour per IP address: poll sparingly without a token.
const pollEvery = active => local.get(TOKEN_KEY) ? (active ? 4 : 30) : (active ? 15 : 300);

async function ghApi(path, init = {}) {
  const token = local.get(TOKEN_KEY);
  const r = await fetch(`https://api.github.com${path}`, {cache: "no-cache", ...init, headers: {
    Accept: "application/vnd.github+json", ...(token && {Authorization: `Bearer ${token}`}), ...init.headers}});
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    if (r.headers.get("x-ratelimit-remaining") === "0") e.reset = 1000 * r.headers.get("x-ratelimit-reset");
    throw e;
  }
  return r.status === 204 ? null : r.json();
}

const stepSeconds = s => s.started_at && s.completed_at ? (new Date(s.completed_at) - new Date(s.started_at)) / 1000 : null;

function initRefresh(box, onUpdated) {
  box.className = "refresh";
  box.innerHTML = `<div class="row">
      <button type="button" class="linkbtn" data-a="token"></button>
      <button type="button" class="btn" data-a="run" disabled>↻ Update now</button>
    </div>
    <div class="progress" hidden>
      <div class="bar" role="progressbar" aria-label="Dashboard update"><i></i></div>
      <div class="sub" aria-live="polite"></div>
    </div>
    <dialog class="tok"><form method="dialog">
      <h3>Start updates from this page</h3>
      <p>Paste a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
        with the dashboard's organization as resource owner, access to the <b>dashboard</b> repository only and
        <b>Actions: Read and write</b>. It stays in this browser and is sent only to api.github.com.</p>
      <input type="password" name="t" placeholder="github_pat_…" autocomplete="off" spellcheck="false">
      <div class="row"><button class="btn" value="remove">Remove</button><span></span>
        <button class="btn" value="cancel">Cancel</button><button class="btn primary" value="save">Save</button></div>
    </form></dialog>`;
  const tokBtn = box.querySelector('[data-a="token"]'), runBtn = box.querySelector('[data-a="run"]');
  const prog = box.querySelector(".progress"), bar = prog.querySelector(".bar"), fill = bar.firstElementChild;
  const txt = prog.querySelector(".sub"), dlg = box.querySelector("dialog"), input = dlg.querySelector("input");

  // phase: idle → waiting (button clicked, no run yet) → running → publishing (run passed,
  // waiting for the new data.json) → idle; `outcome` keeps the result on screen for a while.
  let repo, generated, phase = "idle", run = null, steps = [], estimate = null, outcome = null;
  let note = "", watchUntil = 0, publishUntil = 0, blockedUntil = 0, lastIdlePoll = 0, timer, shownHtml;

  // Step durations of the last passed run: the expected length of each step of this one.
  async function loadEstimate(runs) {
    const prev = runs.find(r => r.conclusion === "success");
    if (!prev) return {};
    const key = `g4med-estimate-${prev.id}`;
    try { const c = sessionStorage.getItem(key); if (c) return JSON.parse(c); } catch {}
    const job = (await ghApi(`/repos/${repo}/actions/runs/${prev.id}/jobs`)).jobs[0];
    const est = Object.fromEntries((job?.steps || []).filter(s => stepSeconds(s) != null).map(s => [s.name, stepSeconds(s)]));
    try { sessionStorage.setItem(key, JSON.stringify(est)); } catch {}
    return est;
  }

  function progress() {
    if (!steps.length) return null;
    let total = 0, done = 0;
    for (const s of steps) {
      const e = Math.max(estimate?.[s.name] ?? 1, 1);
      total += e;
      if (s.status === "completed") done += e;
      else if (s.status === "in_progress" && s.started_at) done += Math.min((Date.now() - new Date(s.started_at)) / 1000, .95 * e);
    }
    return {frac: Math.min(done / total, .99), left: Object.keys(estimate || {}).length ? total - done : null};
  }

  function finish(ok) {
    outcome = {ok, run, until: Date.now() + (ok ? 10000 : 120000)};
    phase = "idle"; run = null; steps = [];
  }

  async function poll() {
    clearTimeout(timer);
    let next = pollEvery(false);
    try {
      if (Date.now() < blockedUntil) next = (blockedUntil - Date.now()) / 1000 + 1;
      else if (phase === "publishing") {
        next = 5;
        const d = await getJSON("data.json");
        if (d.generated_at !== generated || Date.now() > publishUntil) {
          generated = d.generated_at;
          finish(true);
          await onUpdated();
        }
      } else if (run) {
        next = pollEvery(true);
        if (run.status !== "in_progress") run = await ghApi(`/repos/${repo}/actions/runs/${run.id}`);
        if (run.status === "in_progress") {
          const job = (await ghApi(`/repos/${repo}/actions/runs/${run.id}/jobs`)).jobs[0];
          steps = job?.steps || [];
          if (job?.status === "completed") run = {...run, status: "completed", conclusion: job.conclusion};
        }
        if (run.status === "completed") {
          if (run.conclusion === "success") { phase = "publishing"; publishUntil = Date.now() + 120000; next = 1; }
          else finish(false);
        }
      } else if (phase === "waiting" || document.visibilityState === "visible") {
        lastIdlePoll = Date.now();
        const {workflow_runs: runs} = await ghApi(`/repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=10`);
        const active = runs.find(r => r.status !== "completed");
        if (active) {
          run = active; phase = "running"; next = .1; outcome = null; note = "";
          generated = (await getJSON("data.json")).generated_at;
          estimate ??= await loadEstimate(runs).catch(() => ({}));
        } else if (phase === "waiting") {
          next = pollEvery(true);
          if (Date.now() > watchUntil) { phase = "idle"; note = "No update started."; }
        }
      }
      if (note.startsWith("GitHub API limit")) note = "";
    } catch (e) {
      if (e.reset) {
        blockedUntil = e.reset;
        next = (blockedUntil - Date.now()) / 1000 + 1;
        note = `GitHub API limit reached, progress resumes at ${new Date(e.reset).toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"})}` +
          (local.get(TOKEN_KEY) ? "." : " (a token raises the limit).");
      }
    }
    render();
    timer = setTimeout(poll, next * 1000);
  }

  async function start() {
    const token = local.get(TOKEN_KEY);
    note = ""; outcome = null;
    if (!token) window.open(`https://github.com/${repo}/actions/workflows/${WORKFLOW}`, "_blank", "noopener");
    else {
      try {
        await ghApi(`/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`,
          {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({ref: "main"})});
      } catch (e) {
        note = e.status === 401 ? "The token was rejected: expired or revoked?"
          : e.status === 403 || e.status === 404 ? `This token cannot start workflows in ${repo} (it needs Actions: write).`
          : `Could not start the update (${e.message}).`;
        render();
        return;
      }
    }
    phase = "waiting";
    watchUntil = Date.now() + (token ? 90 : 300) * 1000;
    render();
    clearTimeout(timer);
    timer = setTimeout(poll, (token ? 3 : 15) * 1000);
  }

  function render() {
    if (outcome && Date.now() > outcome.until) outcome = null;
    const token = local.get(TOKEN_KEY), busy = phase !== "idle";
    runBtn.disabled = !repo || busy;
    runBtn.textContent = busy ? "Updating…" : "↻ Update now";
    runBtn.title = token ? "Start the dashboard update now"
      : "Opens the workflow on GitHub: click “Run workflow” there (needs write access to the repository)";
    tokBtn.textContent = token ? "Token ✓" : "Use a token";
    tokBtn.title = token ? "Change or remove the token used to start updates" : "Start updates with one click, without going to GitHub";

    let frac = null, css = "", html = "";
    const log = r => r ? ` · <a href="${esc(r.html_url)}" target="_blank" rel="noopener">log ↗</a>` : "";
    if (phase === "waiting") html = token ? "Starting the update…" : "Waiting for the run to start on GitHub…";
    else if (phase === "running" && run.status !== "in_progress") html = `${esc(label(run.status))} on GitHub…${log(run)}`;
    else if (phase === "running") {
      const p = progress(), cur = steps.find(s => s.status === "in_progress");
      frac = p ? p.frac : null;
      html = `${esc(cur?.name || "Running")} · ${since(run.run_started_at)}` +
        `${p?.left != null ? `, ~${fmtDur(Math.max(5, Math.round(p.left)))} left` : ""}${log(run)}`;
    } else if (phase === "publishing") { frac = 1; html = "Publishing the new data…"; }
    else if (outcome) {
      frac = 1; css = outcome.ok ? " ok" : " bad";
      html = outcome.ok ? "Data updated." : `Update ${esc(label(outcome.run.conclusion).toLowerCase())}${log(outcome.run)}`;
    }
    const showBar = busy || !!outcome;
    if (!html) html = esc(note);
    prog.hidden = !html;
    bar.hidden = !showBar;
    bar.className = `bar${frac == null ? " indet" : ""}${css}`;
    fill.style.width = frac == null ? "" : `${(100 * frac).toFixed(1)}%`;
    if (frac == null) bar.removeAttribute("aria-valuenow");
    else bar.setAttribute("aria-valuenow", Math.round(100 * frac));
    if (html !== shownHtml) txt.innerHTML = shownHtml = html;
  }

  runBtn.onclick = start;
  tokBtn.onclick = () => { input.value = ""; dlg.querySelector('[value="remove"]').hidden = !local.get(TOKEN_KEY); dlg.showModal(); };
  dlg.onclose = () => {
    if (dlg.returnValue === "save" && input.value.trim()) local.set(TOKEN_KEY, input.value.trim());
    if (dlg.returnValue === "remove") local.set(TOKEN_KEY, null);
    note = ""; blockedUntil = 0;
    if (dlg.returnValue !== "cancel" && phase === "idle" && repo) poll();
    else render();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && phase === "idle" && !run && Date.now() - lastIdlePoll > 60000) poll();
  });
  setInterval(render, 1000);

  getJSON("data.json").then(d => {
    repo = d.dashboard_repo || `${d.org}/dashboard`;
    generated = d.generated_at;
    poll();
  }).catch(() => { box.hidden = true; });
}
