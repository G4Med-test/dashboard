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
