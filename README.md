# herdr-codebuddy

[![test](https://github.com/Ziy1-Tan/herdr-codebuddy/actions/workflows/test.yml/badge.svg)](https://github.com/Ziy1-Tan/herdr-codebuddy/actions/workflows/test.yml)

CodeBuddy hooks report session state to Herdr. This adds no Herdr process or screen detection.

| CodeBuddy event | Herdr report |
| --- | --- |
| `SessionStart` (`startup`, `resume`, `clear`, `compact`) | `idle`, with the session ID and `codebuddy --resume` command when available |
| `UserPromptSubmit` | `working` |
| `PreToolUse`, `PostToolUse` | `working` |
| `Stop` | `idle` |
| `Notification` (`permission_prompt`) | `blocked` |
| `SessionEnd` | release the agent |

The tool events keep the reported state honest: approving a permission
prompt otherwise left the pane reported as `blocked` until `Stop`.

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
