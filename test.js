'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { EVENTS, decide, buildArgs, currentSeq } = require('./herdr-codebuddy-hook.js');

const HOOK = path.join(__dirname, 'herdr-codebuddy-hook.js');
const INSTALLER = path.join(__dirname, 'install.js');
const EVENT_NAMES = Object.keys(EVENTS);

const BASE_ENV = {
  ...process.env,
  HERDR_ENV: '1',
  HERDR_PANE_ID: 'pane-test',
  HERDR_BIN_PATH: '/fake/herdr',
  HERDR_CODEBUDDY_DRY_RUN: '1',
};

// The contract: which event reports which pane state.
const STATES = [
  ['SessionStart', { session_id: 'session-abc' }, 'idle'],
  ['SessionStart', { session_id: 'session-compact', source: 'compact' }, 'working'],
  ['SessionStart', { session_id: 'session-clear', source: 'clear' }, 'idle'],
  ['UserPromptSubmit', {}, 'working'],
  ['PreToolUse', {}, 'working'],
  ['PostToolUse', {}, 'working'],
  ['PostToolUseFailure', {}, 'working'],
  ['PermissionDenied', {}, 'working'],
  ['Stop', {}, 'idle'],
  ['StopFailure', {}, 'idle'],
  ['Notification', { notification_type: 'permission_prompt' }, 'blocked'],
];

function runHook(event, extra = {}, envOverrides = {}) {
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: event, ...extra }),
    encoding: 'utf8',
    env: { ...BASE_ENV, ...envOverrides },
  }).trim();
  return stdout ? JSON.parse(stdout) : null;
}

function arg(result, flag) {
  return result.args[result.args.indexOf(flag) + 1];
}

// The installer only writes to ~/.codebuddy, so every install test needs its
// own throwaway HOME.
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codebuddy-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const settingsFile = path.join(home, '.codebuddy', 'settings.json');
  const hookFile = path.join(home, '.codebuddy', 'hooks', 'herdr-codebuddy-hook.js');
  const install = action => execFileSync(process.execPath, [INSTALLER, action], { encoding: 'utf8', env });
  try {
    return fn({ home, settingsFile, hookFile, install });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('does not report outside a Herdr pane', () => {
  const result = runHook('UserPromptSubmit', {}, { HERDR_ENV: '', HERDR_PANE_ID: '' });
  assert.equal(result, null);
});

test('maps lifecycle and permission events to report-agent states', () => {
  for (const [event, payload, state] of STATES) {
    const result = runHook(event, payload);
    assert.equal(result.binary, '/fake/herdr');
    assert.deepEqual(result.args.slice(0, 3), ['pane', 'report-agent', 'pane-test']);
    assert.equal(arg(result, '--state'), state);
    assert.equal(arg(result, '--source'), 'custom:codebuddy');
    assert.equal(arg(result, '--agent'), 'codebuddy');
    assert.ok(Number(arg(result, '--seq')) >= 1e18);
    if (event === 'SessionStart') {
      assert.equal(arg(result, '--agent-session-id'), payload.session_id);
      assert.deepEqual(result.args.slice(result.args.indexOf('--') + 1), [
        'codebuddy', '--resume', payload.session_id,
      ]);
    }
  }
});

// decide() is the pure core; the subprocess tests below only prove the wiring.
test('decide ignores unknown, malformed, and unrelated events', () => {
  assert.equal(decide(null), null);
  assert.equal(decide('not an object'), null);
  assert.equal(decide({ hook_event_name: 'NotAnEvent' }), null);
  assert.equal(decide({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
});

test('decide maps one event to one report', () => {
  assert.deepEqual(decide({ hook_event_name: 'Stop' }), {
    name: 'Stop', state: 'idle', sessionId: null, message: null,
  });
  assert.deepEqual(decide({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), {
    name: 'Notification', state: 'blocked', sessionId: null, message: 'CodeBuddy permission required',
  });
  assert.equal(decide({ hook_event_name: 'SessionStart', session_id: "bad'id" }).sessionId, null);
});

test('buildArgs is a pure function of the decision', () => {
  const report = decide({ hook_event_name: 'SessionStart', session_id: 'session-abc' });
  assert.deepEqual(buildArgs(report, 'pane-test', 7), [
    'pane', 'report-agent', 'pane-test',
    '--source', 'custom:codebuddy', '--agent', 'codebuddy', '--seq', '7',
    '--state', 'idle',
    '--agent-session-id', 'session-abc', '--', 'codebuddy', '--resume', 'session-abc',
  ]);
});

test('seq is nanosecond-scale, decimal, and strictly increasing', async () => {
  const first = currentSeq();
  assert.match(first, /^\d{19}$/);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(BigInt(currentSeq()) > BigInt(first));
});

test('every registered event has a test', () => {
  const covered = new Set([...STATES.map(([event]) => event), 'SessionEnd']);
  assert.deepEqual(EVENT_NAMES.filter(name => !covered.has(name)), []);
});

test('omits recovery data for invalid session IDs', () => {
  const result = runHook('SessionStart', { session_id: "bad'id" });
  assert.ok(!result.args.includes('--agent-session-id'));
  assert.ok(!result.args.includes('--'));
});

test('releases the reported agent on SessionEnd', () => {
  for (const reason of ['logout', 'prompt_input_exit', 'other']) {
    const result = runHook('SessionEnd', { reason });
    assert.deepEqual(result.args.slice(0, 3), ['pane', 'release-agent', 'pane-test']);
    assert.ok(!result.args.includes('--state'));
  }
});

// /clear ends the conversation, not the process, and CodeBuddy pairs
// SessionEnd(clear) with SessionStart(clear), which reports idle plus the
// new session id. Reporting here too would race it for the higher --seq,
// and Herdr drops the loser -- the session id.
test('reports nothing on /clear', () => {
  assert.equal(runHook('SessionEnd', { reason: 'clear' }), null);
  assert.equal(decide({ hook_event_name: 'SessionEnd', reason: 'clear' }), null);
});

test('logs a spawn failure and still exits cleanly', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-codebuddy-log-'));
  try {
    fs.mkdirSync(path.join(home, '.codebuddy', 'hooks'), { recursive: true });
    const stdout = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_ENV: '1',
        HERDR_PANE_ID: 'pane-test',
        HERDR_BIN_PATH: '/nonexistent/herdr',
        HOME: home,
        USERPROFILE: home,
      },
    }).trim();
    assert.equal(stdout, '');
    const log = fs.readFileSync(path.join(home, '.codebuddy', 'hooks', 'herdr-codebuddy.log'), 'utf8');
    assert.match(log, / Stop: spawn ".*" failed \(ENOENT\)\n$/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ignores unrelated notifications and malformed JSON', () => {
  assert.equal(runHook('Notification', { notification_type: 'idle_prompt' }), null);
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: '{bad json',
    encoding: 'utf8',
    env: BASE_ENV,
  }).trim();
  assert.equal(stdout, '');
});

// isOurHook matches on the file name alone, so a command that merely
// mentions the hook file counts as ours and is removed -- including an
// unrelated one like the rm below. Deliberate: a strict match would leave a
// duplicate behind when an older install quoted the command differently.
test('install treats any command mentioning the hook file as ours', () => withHome(home => {
  const { settingsFile, install } = home;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'rm ~/.codebuddy/hooks/herdr-codebuddy-hook.js' }] }] },
  }));
  install('uninstall');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), {});
}));

test('uninstall leaves settings alone when the adapter is absent', () => withHome(home => {
  const { settingsFile, install } = home;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const original = JSON.stringify({ theme: 'dark' });
  fs.writeFileSync(settingsFile, original);
  install('uninstall');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
}));

test('installer keeps one backup of the hook it replaces', () => withHome(home => {
  const { settingsFile, hookFile, install } = home;
  const backupFile = `${hookFile}.bak`;

  install('install');
  assert.ok(!fs.existsSync(backupFile));

  fs.appendFileSync(hookFile, '// local edit\n');
  assert.equal(install('install'), 'Herdr CodeBuddy hooks installed. Restart CodeBuddy to load them.\n');
  assert.ok(fs.readFileSync(backupFile, 'utf8').endsWith('// local edit\n'));
  assert.ok(!fs.readFileSync(hookFile, 'utf8').endsWith('// local edit\n'));

  assert.equal(install('install'), 'Herdr CodeBuddy hooks already installed. Restart CodeBuddy to load them.\n');
  assert.deepEqual(fs.readdirSync(path.dirname(hookFile)).filter(name => name.endsWith('.bak')).sort(), ['herdr-codebuddy-hook.js.bak']);
  assert.ok(fs.readFileSync(backupFile, 'utf8').endsWith('// local edit\n'));

  install('uninstall');
  assert.ok(!fs.existsSync(hookFile));
  assert.ok(!fs.existsSync(backupFile));
  // Settings created by the install go away with it instead of leaving `hooks: {}`.
  assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), 'hooks'));
}));

test('installer is idempotent and uninstall preserves unrelated hooks', () => withHome(home => {
  const { settingsFile, hookFile, install } = home;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const original = {
    theme: 'dark',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }],
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2));

  const first = install('install');
  assert.equal(first, 'Herdr CodeBuddy hooks installed. Restart CodeBuddy to load them.\n');

  assert.equal(install('install'), 'Herdr CodeBuddy hooks already installed. Restart CodeBuddy to load them.\n');
  const settingsBackups = fs.readdirSync(path.dirname(settingsFile))
    .filter(name => /^settings\.json\.herdr-codebuddy-.*\.bak$/.test(name));
  assert.equal(settingsBackups.length, 1);

  const installed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(installed.theme, 'dark');
  assert.equal(installed.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.equal(installed.hooks.Notification[0].matcher, 'permission_prompt');
  assert.equal(installed.hooks.Stop.length, 2);
  for (const event of EVENT_NAMES) {
    assert.equal(installed.hooks[event].filter(entry => entry.hooks?.some(hook => hook.command?.includes('herdr-codebuddy-hook.js'))).length, 1);
  }
  assert.ok(fs.existsSync(hookFile));

  const removed = install('uninstall');
  assert.equal(removed, 'Herdr CodeBuddy hooks removed.\n');
  const uninstalled = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(uninstalled.theme, 'dark');
  assert.deepEqual(uninstalled.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }]);
  for (const event of EVENT_NAMES.filter(name => name !== 'Stop')) {
    assert.ok(!Object.hasOwn(uninstalled.hooks, event));
  }
  assert.ok(!fs.existsSync(hookFile));
}));
