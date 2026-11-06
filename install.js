#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EVENTS } = require('./herdr-codebuddy-hook.js');

const HOOK_NAME = 'herdr-codebuddy-hook.js';
const COMMAND = `node "$HOME/.codebuddy/hooks/${HOOK_NAME}"`;

// Match on the file name, so a hook registered by an older install (different
// quoting or path) is replaced instead of duplicated.
const isOurHook = hook => typeof hook?.command === 'string' && hook.command.includes(HOOK_NAME);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function removeOurHooks(entries) {
  return entries.flatMap(entry => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter(hook => !isOurHook(hook));
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
}

// Write through a temp file so an interrupted run never leaves a truncated
// settings.json. rename() replaces the target atomically on both POSIX and
// Windows (MoveFileEx with MOVEFILE_REPLACE_EXISTING).
function writeSettings(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function readSettings(file) {
  let original;
  try {
    original = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { original: null, settings: {} };
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }

  let settings;
  try {
    settings = JSON.parse(original);
  } catch (error) {
    throw new Error(`Cannot parse ${file}: ${error.message}`);
  }
  if (!isPlainObject(settings)) throw new Error(`${file} must contain a JSON object`);
  return { original, settings };
}

function main() {
  const action = process.argv[2] || 'install';
  if (action !== 'install' && action !== 'uninstall') {
    throw new Error('Usage: node install.js [install|uninstall]');
  }

  const dir = path.join(os.homedir(), '.codebuddy');
  const settingsFile = path.join(dir, 'settings.json');
  const hookFile = path.join(dir, 'hooks', HOOK_NAME);
  fs.mkdirSync(dir, { recursive: true });

  const { original, settings } = readSettings(settingsFile);
  const originalHooks = settings.hooks;
  if (originalHooks !== undefined && !isPlainObject(originalHooks)) {
    throw new Error('settings.hooks must be an object');
  }

  const hooks = { ...originalHooks };
  for (const [event, spec] of Object.entries(EVENTS)) {
    const entries = hooks[event] ?? [];
    if (!Array.isArray(entries)) throw new Error(`settings.hooks.${event} must be an array`);

    const remaining = removeOurHooks(entries);
    if (action === 'install') {
      const entry = { hooks: [{ type: 'command', command: COMMAND }] };
      if (spec.matcher) entry.matcher = spec.matcher;
      hooks[event] = [...remaining, entry];
    } else if (remaining.length) {
      hooks[event] = remaining;
    } else {
      delete hooks[event];
    }
  }

  const updated = { ...settings };
  if (action === 'install' || Object.keys(hooks).length) updated.hooks = hooks;
  else delete updated.hooks;

  const changed = JSON.stringify(settings) !== JSON.stringify(updated);
  let backup = null;
  if (changed) {
    if (original !== null) {
      backup = `${settingsFile}.herdr-codebuddy-${Date.now()}.bak`;
      fs.copyFileSync(settingsFile, backup);
    }
    writeSettings(settingsFile, `${JSON.stringify(updated, null, 2)}\n`);
  }
  const backupNote = backup ? ` (backup: ${backup})` : '';

  if (action === 'uninstall') {
    const existed = fs.existsSync(hookFile) || fs.existsSync(`${hookFile}.bak`);
    fs.rmSync(hookFile, { force: true });
    fs.rmSync(`${hookFile}.bak`, { force: true });
    console.log(changed || existed
      ? `Removed Herdr CodeBuddy hooks from ${settingsFile}${backupNote}.`
      : `No Herdr CodeBuddy hooks in ${settingsFile}.`);
    return;
  }

  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  // One copy deep, so a bad update can be rolled back by copying the .bak back.
  const sourceFile = path.join(__dirname, HOOK_NAME);
  const exists = fs.existsSync(hookFile);
  const replaced = exists && !fs.readFileSync(hookFile).equals(fs.readFileSync(sourceFile));
  if (replaced) {
    fs.copyFileSync(hookFile, `${hookFile}.bak`);
    fs.copyFileSync(sourceFile, hookFile);
  } else if (!exists) {
    fs.copyFileSync(sourceFile, hookFile);
  }

  if (changed) console.log(`Installed hooks in ${settingsFile}${backupNote}.`);
  else if (!replaced) console.log(`Hooks already installed in ${settingsFile}.`);
  if (replaced) console.log(`Replaced hook script ${hookFile} (backup: ${hookFile}.bak).`);
  console.log('Restart CodeBuddy to load them.');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
