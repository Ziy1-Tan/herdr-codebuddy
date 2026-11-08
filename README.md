# herdr-codebuddy

[![test](https://github.com/Ziy1-Tan/herdr-codebuddy/actions/workflows/test.yml/badge.svg)](https://github.com/Ziy1-Tan/herdr-codebuddy/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

CodeBuddy hooks report session state to Herdr. This adds no Herdr process or screen detection.

| CodeBuddy event | Herdr report |
| --- | --- |
| `SessionStart` (`startup`, `resume`, `clear`) | `idle`, with the session ID and `codebuddy --resume` command when available |
| `SessionStart` (`compact`) | `working` |
| `UserPromptSubmit` | `working` |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `working` |
| `PermissionDenied` | `working` |
| `Stop`, `StopFailure` | `idle` |
| `Notification` (`permission_prompt`) | `blocked` |
| `SessionEnd` | release the agent; `/clear` reports `idle` |

## Install

Requirements: `curl`, Node.js, and CodeBuddy.

```sh
curl -fsSL https://raw.githubusercontent.com/Ziy1-Tan/herdr-codebuddy/main/install.sh | sh
```

To uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/Ziy1-Tan/herdr-codebuddy/main/install.sh | sh -s -- uninstall
```

For a local checkout, run `node install.js install` or `node install.js uninstall`.

## Test

```sh
npm test
```

Reference: [Add Herdr support to your agent](https://herdr.dev/docs/add-herdr-support/).
