#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

// Shared with install.js: one row per CodeBuddy event, holding both the matcher
// to register and the Herdr state to report. A row without a `state` releases
// the agent instead of reporting one.
const EVENTS = {
  // /clear starts a new session, so the pane must follow the new id; 'compact'
  // keeps the session and continues the turn, so the pane is still working.
  SessionStart: { matcher: 'startup|resume|clear|compact', state: 'idle' },
  UserPromptSubmit: { state: 'working' },
  // PreToolUse runs before the permission prompt; the events after it clear a
  // 'blocked' left by an approved prompt, and the next tool call recovers after
  // a denied one instead of holding 'blocked' until Stop.
  PreToolUse: { state: 'working' },
  PostToolUse: { state: 'working' },
  PostToolUseFailure: { state: 'working' },
  Stop: { state: 'idle' },
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
  // CodeBuddy applies the matcher already; re-checking keeps a hand-edited
  // settings.json from reporting a blocked pane for an unrelated notification.
  if (name === 'Notification' && event.notification_type !== 'permission_prompt') return;

  const args = [
    'pane', spec.state ? 'report-agent' : 'release-agent', HERDR_PANE_ID,
    '--source', 'custom:codebuddy',
    '--agent', 'codebuddy',
    '--seq', String(Date.now()),
  ];

  if (spec.state) {
    // Compaction runs mid-turn, before the agent continues, so the pane works.
    const state = name === 'SessionStart' && event.source === 'compact' ? 'working' : spec.state;
    args.push('--state', state);
  }
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
