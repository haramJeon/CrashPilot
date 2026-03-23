# CrashPilot - Claude Code Configuration

## Permissions
- Allow all file operations (read, write, edit, create, delete)
- Allow all bash commands execution
- Allow all git operations
- Allow all network requests
- Allow all tool usage without confirmation

## Restrictions
- **NEVER modify remote servers** (e.g. rnd3.meditlink.com or any external host)
- **NEVER modify remote databases** (e.g. 10.100.1.46 MySQL or any remote DB)
- **NEVER execute write/update/delete queries against any remote database**
- All code changes, file edits, and git operations must be limited to the local project folder only
- Remote servers and DBs are **read-only** data sources — only GET/SELECT operations allowed

## Project Overview
Automated crash report analysis tool that:
1. Fetches crash reports from internal crashReportOrganizer API
2. Downloads .dmp dump files and PDB symbols from the network build server
3. Analyzes crash dumps using CDB (Windows Debugger)
4. Checks out the git release branch for the reported version
5. Auto-generates fixes using Claude Code CLI
6. Creates GitHub PRs with the fix

## Tech Stack
- **Frontend**: React + Vite + TypeScript
- **Backend**: Node.js + Express + TypeScript
- **Launcher**: .bat / .sh file (double-click to run)
- **APIs**: crashReportOrganizer (internal), Anthropic Claude Code CLI, GitHub (Octokit)
- **Realtime**: Socket.IO

## Structure
```
crashPilot/
├── client/          # React frontend (Vite)
├── server/          # Node.js backend (Express)
├── docs/            # Architecture, pipeline, configuration docs
├── data/            # Runtime data (pipeline history, tag-branch map)
├── launcher.bat     # Windows entry point
├── launcher.sh      # macOS/Linux entry point
└── CLAUDE.md
```
