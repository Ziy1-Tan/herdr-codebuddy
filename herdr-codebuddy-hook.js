#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

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
  SessionEnd: {},
};

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/;

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

  const name = event?.hook_event_name;
  if (!Object.hasOwn(EVENTS, name)) return;
  const spec = EVENTS[name];
  // CodeBuddy applies the matcher already; this survives a hand-edited
  // settings.json that matches an unrelated notification.
  if (name === 'Notification' && event.notification_type !== 'permission_prompt') return;

  // 'compact' keeps the turn running and /clear keeps the process alive, so
  // neither matches its row.
  let state = spec.state;
  if (name === 'SessionStart' && event.source === 'compact') state = 'working';
  if (name === 'SessionEnd' && event.reason === 'clear') state = 'idle';

  const args = [
    'pane', state ? 'report-agent' : 'release-agent', HERDR_PANE_ID,
    '--source', 'custom:codebuddy',
    '--agent', 'codebuddy',
    '--seq', String(Date.now()),
  ];

  if (state) args.push('--state', state);
  if (name === 'SessionStart' && typeof event.session_id === 'string' && SESSION_ID.test(event.session_id)) {
    args.push('--agent-session-id', event.session_id, '--', 'codebuddy', '--resume', event.session_id);
  }
  if (name === 'Notification') args.push('--message', 'CodeBuddy permission required');

  if (process.env.HERDR_CODEBUDDY_DRY_RUN === '1') {
    console.log(JSON.stringify({ binary: HERDR_BIN_PATH, args }));
    return;
  }

  // Detached so a slow Herdr never holds up the CodeBuddy turn.
  const child = spawn(HERDR_BIN_PATH, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

module.exports = { EVENTS };

if (require.main === module) main().catch(() => {});
