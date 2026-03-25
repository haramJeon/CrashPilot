# CrashPilot - Claude Code Configuration

## Permissions
- Allow all file operations (read, write, edit, create, delete)
- Allow all bash commands execution
- Allow all git operations
- Allow all network requests
- Allow all tool usage without confirmation

## Restrictions
- **NEVER modify remote servers** (e.g. rnd3.meditlink.com or any external host)
- **NEVER execute write/update/delete queries against any remote database**
- All code changes, file edits, and git operations must be limited to the local project folder only
- Remote servers and DBs are **read-only** data sources — only GET/SELECT operations allowed

## Project Overview
CrashPilot is a desktop tool that fetches C++ crash reports, runs analysis via Claude CLI, and creates GitHub PRs with suggested fixes.

**Stack**: Express (Node.js/TypeScript) backend + React/Vite frontend, packaged as a standalone executable.

## Architecture

```
client/src/
  pages/          # Dashboard, CrashDetail, Settings
  components/     # Layout, PipelineView, StatusBadge
  hooks/          # useApi, useSocket

server/src/
  routes/         # config, crash, git, pipeline (Express routers)
  services/
    claude.ts         # Spawns Claude CLI with embedded crash analysis prompt
    crashReportServer.ts  # Fetches crash reports from external server (read-only)
    dump.ts           # Parses CDB output files
    git.ts            # Local git operations (checkout, diff, apply patch)
    github.ts         # GitHub API — creates PRs
    config.ts         # App config (model, repo path, server URL, etc.)
  utils/
    appPaths.ts       # getAppRoot() / getDataRoot() → resolves paths for both dev and packaged exe
```

## Key Behaviors
- **Crash analysis prompt** is embedded in `server/src/services/claude.ts` — not in this file. Edit there to change Claude's analysis behavior.
- **User data / config** lives in `%ProgramData%/CrashPilot/` (resolved via `getDataRoot()`), not next to the exe.
- **Claude CLI** is spawned with `--dangerously-skip-permissions` and `--no-session-persistence`; `cwd` is set to the user's C++ source repo.
- **Socket.IO** is used to stream live analysis logs to the frontend.

## Dev Commands
```
npm run dev          # start both server (ts-node) and client (vite) concurrently
npm run build        # build client then server
npm run build:release  # package as standalone exe (see scripts/build-release.js)
```
