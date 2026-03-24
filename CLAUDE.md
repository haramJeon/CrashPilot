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

## Crash Analysis Guidelines

### Reading CDB Output
- Focus on the top frame with source info — frames without symbols are usually OS/runtime internals
- `EXCEPTION_ACCESS_VIOLATION` (0xC0000005): check read/write address; address near 0x0~0xFF = null deref, large address = corrupted pointer
- `EXCEPTION_STACK_OVERFLOW` (0xC00000FD): look for recursive call patterns in the stack
- `0xC0000374` (heap corruption): the crash site is often NOT where corruption happened — look for the earliest suspicious frame
- `0x40000015` / `STATUS_FATAL_APP_EXIT`: usually std::terminate — look for unhandled exception or pure virtual call

### Common C++ Crash Patterns
- **Null/dangling pointer**: check object lifetime — raw ptr after container clear, ptr to local var escaping scope
- **Use-after-free**: check shared_ptr cycles, callbacks holding raw refs to destroyed objects
- **Iterator invalidation**: modification of container (insert/erase) during iteration
- **Thread safety**: non-deterministic crashes often mean unsynchronized shared state — look for missing locks
- **RAII violations**: early return / exception paths that skip cleanup or leave state inconsistent
- **Virtual call on destroyed object**: vtable pointer corrupted — destructor called before last use

### Fix Principles
- Make the **minimal possible change** — do not refactor surrounding code
- Prefer null checks / early returns / guards over restructuring logic
- Do not change function signatures or public APIs
- If the root cause is unclear from the dump alone, apply a defensive fix and note uncertainty in the PR description
- If the fix touches shared or core code, flag it explicitly for reviewer attention

### PR Description Requirements
- Always include: crash ID, exception code, faulting module, top 3 meaningful stack frames
- State confidence level: **"Root cause confirmed"** vs **"Defensive fix — root cause unclear from dump"**
- Describe what condition triggered the crash and what the fix prevents