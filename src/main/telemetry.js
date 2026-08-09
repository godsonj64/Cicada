'use strict';

// Minimal, transparent telemetry.
//
// The ONLY thing Cicada ever sends is the first-run signup — name, email, app
// version, platform — and only after the user submits the signup form (which
// states exactly this). It is delivered as an issue in the developer's PRIVATE
// telemetry repository, so signup emails are never exposed publicly. No code,
// prompts, project contents, or usage data are ever transmitted.
//
// Delivery requires a token with access to that one repo. Ship builds with a
// FINE-GRAINED personal access token scoped to ONLY the telemetry repo with
// ONLY "Issues: write" permission — anyone can extract an embedded token from
// a distributed app, so the blast radius must be a single private issue
// tracker and nothing else. NEVER embed a classic `repo`-scope token here.
// Without a token, telemetry is silently disabled and the signup stays local.

const TELEMETRY_REPO = 'godsonj64/cicada-telemetry';

// Filled at release time (see README "Signup & telemetry"). Resolution order:
// config.telemetryToken > GARM_TELEMETRY_TOKEN env > this constant.
const EMBEDDED_TELEMETRY_TOKEN = 'github_pat_…your token…';

function token(config) {
  const candidate = (config && config.telemetryToken) ||
    process.env.GARM_TELEMETRY_TOKEN ||
    EMBEDDED_TELEMETRY_TOKEN || '';
  // Placeholder/example strings must never make telemetry appear enabled and then
  // generate a failing GitHub request on every launch.
  return /^(?:github_pat_[A-Za-z0-9_]{30,}|ghp_[A-Za-z0-9]{30,})$/.test(candidate) ? candidate : '';
}

function enabled(config) {
  return !!token(config);
}

// Deliver one signup as an issue in the private telemetry repo. Resolves with
// { ok } / { ok:false, disabled:true } / { ok:false, error }. Never throws on
// HTTP errors; network failures reject and the caller retries on a later launch.
async function sendSignup(config, profile, meta) {
  const t = token(config);
  if (!t) return { ok: false, disabled: true };
  const res = await fetch(`https://api.github.com/repos/${TELEMETRY_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + t,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cicada-ide',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'signup: ' + (profile.email || profile.name || 'unknown'),
      body: [
        'New Cicada signup',
        '',
        '- Name: ' + (profile.name || '—'),
        '- Email: ' + (profile.email || '—'),
        '- App version: ' + (meta.version || '?'),
        '- Platform: ' + (meta.platform || '?') + ' ' + (meta.arch || ''),
        '- Signed up: ' + (profile.createdAt || meta.at || ''),
      ].join('\n'),
      labels: ['signup'],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: 'GitHub API ' + res.status + ': ' + txt.slice(0, 150) };
  }
  return { ok: true };
}

module.exports = { sendSignup, enabled, TELEMETRY_REPO };
