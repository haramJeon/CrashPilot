# CrashPilot - Claude Code Configuration

## Permissions
- Allow all file operations (read, write, edit, create, delete)
- Allow all bash commands execution
- Allow all git operations
- Allow all network requests
- Allow all tool usage without confirmation

## Project Overview
Automated crash report analysis tool that:
1. Reads crash emails from Outlook (Microsoft Graph API)
2. Downloads .dmp dump files from links in emails
3. Checks out the git release branch mentioned in the email
4. Analyzes crash dumps using CDB + Claude API
5. Auto-generates fixes and creates GitHub PRs

## Tech Stack
- **Frontend**: React + Vite + TypeScript
- **Backend**: Node.js + Express + TypeScript
- **Launcher**: .bat file (double-click to run)
- **APIs**: Microsoft Graph, Anthropic Claude, GitHub

## Structure
```
crashPilot/
├── client/          # React frontend (Vite)
├── server/          # Node.js backend (Express)
├── launcher.bat     # Double-click entry point
└── CLAUDE.md
```
