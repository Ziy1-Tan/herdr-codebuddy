#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMMAND = 'node "$HOME/.codebuddy/hooks/herdr-codebuddy-hook.js"';
const EVENTS = {
  // clear and compact also start a session with a new id. Without them the
  // pane keeps an older id, and a Herdr server restart resumes the session
  // from before /clear or the compaction.
  SessionStart: 'startup|resume|clear|compact',
  UserPromptSubmit: null,
  PreToolUse: null,
  PostToolUse: null,
  Stop: null,
  Notification: 'permission_prompt',
  SessionEnd: null,
};

function removeOurHook(entries) {
  return entries.flatMap(entry => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter(hook => hook.command !== COMMAND);
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
}

function main() {
  const action = process.argv[2] || 'install';
  if (!['install', 'uninstall'].includes(action)) {
    throw new Error('Usage: node install.js [install|uninstall]');
  }

  const dir = path.join(os.homedir(), '.codebuddy');
  const settingsFile = path.join(dir, 'settings.json');
  const hookFile = path.join(dir, 'hooks', 'herdr-codebuddy-hook.js');
  fs.mkdirSync(dir, { recursive: true });

  let original = null;
  let settings = {};
  try {
    original = fs.readFileSync(settingsFile, 'utf8');
    settings = JSON.parse(original);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${settingsFile}: ${error.message}`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${settingsFile} must contain a JSON object`);
  }

  const originalHooks = settings.hooks;
  if (originalHooks !== undefined && (!originalHooks || typeof originalHooks !== 'object' || Array.isArray(originalHooks))) {
    throw new Error('settings.hooks must be an object');
  }

  const hooks = { ...(originalHooks || {}) };
  for (const [event, matcher] of Object.entries(EVENTS)) {
    const entries = originalHooks?.[event] ?? [];
    if (!Array.isArray(entries)) throw new Error(`settings.hooks.${event} must be an array`);

    const remaining = removeOurHook(entries);
    if (action === 'install') {
      const hook = { type: 'command', command: COMMAND };
      const entry = { hooks: [hook] };
      if (matcher) entry.matcher = matcher;
      hooks[event] = [...remaining, entry];
    } else if (remaining.length) {
      hooks[event] = remaining;
    } else if (entries.length) {
      delete hooks[event];
    }
  }

  const updated = { ...settings };
  if (originalHooks !== undefined || action === 'install') updated.hooks = hooks;
  const content = `${JSON.stringify(updated, null, 2)}\n`;
  const unchanged = original !== null && JSON.stringify(settings) === JSON.stringify(updated);

  if (!unchanged) {
    if (original !== null) {
      fs.copyFileSync(settingsFile, `${settingsFile}.herdr-codebuddy-${Date.now()}.bak`);
    }
    const tempFile = `${settingsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, content, { mode: 0o600 });
    try {
      fs.renameSync(tempFile, settingsFile);
    } catch (error) {
      if (process.platform !== 'win32' || !fs.existsSync(settingsFile)) {
        fs.rmSync(tempFile, { force: true });
        throw error;
      }

      const previousFile = `${settingsFile}.${process.pid}.previous`;
      fs.renameSync(settingsFile, previousFile);
      try {
        fs.renameSync(tempFile, settingsFile);
        fs.rmSync(previousFile, { force: true });
      } catch (replaceError) {
        fs.renameSync(previousFile, settingsFile);
        fs.rmSync(tempFile, { force: true });
        throw replaceError;
      }
    }
  }

  if (action === 'install') {
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'herdr-codebuddy-hook.js'), hookFile);
    console.log(`Installed hooks in ${settingsFile}. Restart CodeBuddy to load them.`);
  } else {
    fs.rmSync(hookFile, { force: true });
    console.log(`Removed Herdr CodeBuddy hooks from ${settingsFile}.`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
