---
name: session-status
description: 显示当前本地会话的 Token、缓存命中率、5 小时剩余、重置时间和 Codex/Work 模式。
disable-model-invocation: true
---

Call this plugin's `show_session_status` tool for the current conversation.
The executor's real thread metadata is preferred, so first call it without arguments.
If the result has no binding, read only `CODEX_THREAD_ID` through the local execution tool,
validate it as a UUID, and call again with that exact `session_id`.
Never substitute the latest log, another project's thread, or anonymized `openai/session`.
Do not infer Work/Codex from model names or tools. Trust the returned mode or show unknown.
Do not read credentials, send messages, restart the app, or change client installation files.
Report unavailable values and native UI limitations honestly. A text result is not proof of
an installed panel or successful automatic project switching.
