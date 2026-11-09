#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Shared with install.js: the matcher to register and the state to report.
const EVENTS = {
  SessionStart: { matcher: 'startup|resume|clear|compact', state: 'idle' },
  UserPromptSubmit: { state: 'working' },
  // Nothing fires for the answer to a prompt, so the tool events are the only
  // thing that clears `blocked`, and a long approved tool keeps it.
  PreToolUse: { state: 'working' },
  PostToolUse: { state: 'working' },
  PostToolUseFailure: { state: 'working' },
  // The auto-mode classifier denies without a tool event following.
  PermissionDenied: { state: 'working' },
  Stop: { state: 'idle' },
  // A turn that ends on an API error sends no Stop.
  StopFailure: { state: 'idle' },
  Notification: { matcher: 'permission_prompt', state: 'blocked' },
  // /clear pairs this with a SessionStart(clear). Report nothing here: the
  // seq of each report is Date.now() read after that hook's stdin, so these
  // back-to-back reports can invert order, and Herdr drops the lower seq --
  // losing the new session id that a Herdr restart would restore.
  SessionEnd: {},
};

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/;

// What one hook event should report, or null when it maps to nothing.
// Pure: reads the event only, no env, no I/O.
function decide(event) {
  const name = event?.hook_event_name;
  if (!Object.hasOwn(EVENTS, name)) return null;
  // CodeBuddy applies the matcher already; this survives a hand-edited
  // settings.json that matches an unrelated notification.
  if (name === 'Notification' && event.notification_type !== 'permission_prompt') return null;

  // 'compact' keeps the turn running, so it stays working; /clear's
  // SessionEnd is skipped entirely (see the SessionEnd row above).
  let state = EVENTS[name].state;
  if (name === 'SessionStart' && event.source === 'compact') state = 'working';
  if (name === 'SessionEnd' && event.reason === 'clear') return null;

  const sessionId = name === 'SessionStart'
    && typeof event.session_id === 'string'
    && SESSION_ID.test(event.session_id)
    ? event.session_id
    : null;

  return {
    name,
    state,
    sessionId,
    message: name === 'Notification' ? 'CodeBuddy permission required' : null,
  };
}

// The Herdr argv for one decision. Pure apart from the clock.
function buildArgs(report, paneId, seq = Date.now()) {
  const { state, sessionId, message } = report;
  const args = [
    'pane', state ? 'report-agent' : 'release-agent', paneId,
    '--source', 'custom:codebuddy',
    '--agent', 'codebuddy',
    '--seq', String(seq),
  ];
  if (state) args.push('--state', state);
  if (sessionId) args.push('--agent-session-id', sessionId, '--', 'codebuddy', '--resume', sessionId);
  if (message) args.push('--message', message);
  return args;
}

async function main() {
  const { HERDR_ENV, HERDR_PANE_ID, HERDR_BIN_PATH } = process.env;
  if (HERDR_ENV !== '1' || !HERDR_PANE_ID || !HERDR_BIN_PATH) return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }

  const report = decide(event);
  if (!report) return;
  const args = buildArgs(report, HERDR_PANE_ID);

  if (process.env.HERDR_CODEBUDDY_DRY_RUN === '1') {
    console.log(JSON.stringify({ binary: HERDR_BIN_PATH, args }));
    return;
  }

  // Detached so a slow Herdr never holds up the CodeBuddy turn. Waiting for
  // spawn/error only learns whether exec happened (milliseconds); it never
  // waits on Herdr itself.
  const child = spawn(HERDR_BIN_PATH, args, { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise(resolve => {
    child.once('spawn', resolve);
    child.once('error', error => {
      // Herdr's contract says to ignore failures. One log line keeps a dead
      // binary from being a mystery; delete the file whenever.
      try {
        const line = `${new Date().toISOString()} ${report.name}: spawn ${JSON.stringify(HERDR_BIN_PATH)} failed (${error.code || error.message})\n`;
        fs.appendFileSync(path.join(os.homedir(), '.codebuddy', 'hooks', 'herdr-codebuddy.log'), line);
      } catch { /* nowhere to log, nowhere to complain */ }
      resolve();
    });
  });
  child.unref();
}

module.exports = { EVENTS, decide, buildArgs };

if (require.main === module) main().catch(() => {});
