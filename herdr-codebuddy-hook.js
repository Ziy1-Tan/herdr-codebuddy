#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const EVENT_STATES = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  // PreToolUse runs before the permission system and PostToolUse after the tool
  // succeeds, so together they clear a 'blocked' left by an approved
  // permission_prompt instead of holding it until Stop.
  PreToolUse: 'working',
  PostToolUse: 'working',
  Stop: 'idle',
  Notification: 'blocked',
};

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

  const name = event.hook_event_name || event.event;
  const release = name === 'SessionEnd';
  if (!release && !Object.hasOwn(EVENT_STATES, name)) return;
  if (name === 'Notification' && event.notification_type !== 'permission_prompt') return;

  const args = [
    'pane', release ? 'release-agent' : 'report-agent', HERDR_PANE_ID,
    '--source', 'custom:codebuddy',
    '--agent', 'codebuddy',
    '--seq', String(Date.now()),
  ];

  if (!release) args.push('--state', EVENT_STATES[name]);
  if (name === 'SessionStart' && typeof event.session_id === 'string'
      && /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(event.session_id)) {
    args.push(
      '--agent-session-id', event.session_id,
      '--', 'codebuddy', '--resume', event.session_id,
    );
  }
  if (name === 'Notification') args.push('--message', 'CodeBuddy permission required');

  if (process.env.HERDR_CODEBUDDY_DRY_RUN === '1') {
    console.log(JSON.stringify({ binary: HERDR_BIN_PATH, args }));
  } else {
    const child = spawn(HERDR_BIN_PATH, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  }

}

main().catch(() => {});
