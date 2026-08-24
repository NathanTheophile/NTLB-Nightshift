# 09 — Chats and GPT

## 1. Chats

Chats are NightShift-native, non-coding project conversations.

They exist so the user can ask:
- architecture questions;
- where something is implemented;
- design/reflection questions;
- repository understanding;
- documentation questions;

without giving a coding agent write permissions.

## 2. Chat runtime decision

Chats use **FCC with a lightweight model**.

No local LLM is required.

Preferred conceptual path:

```text
NightShift Chat
→ NightShift chat runtime
→ FCC model endpoint
→ selected lightweight/free model
```

This avoids invoking Codex/Claude Code merely to have a discussion.

## 3. Chat capabilities

Read-only project tools may include:
- list/search files;
- read selected files;
- repository search;
- Git status/log/diff read operations;
- NightShift project metadata.

Chats must not:
- edit files;
- commit;
- push;
- launch arbitrary destructive commands.

## 4. Chat model

Model can be selected when Chat is created and should normally be locked per conversation for consistency.

Exact lightweight default is not yet locked.

## 5. Chat context strategy

Do not send the entire repository on every turn.

Use:
- explicit file reads;
- search;
- bounded retrieved context;
- conversation history;
- project authority/pinned files later.

## 6. Chat → Planner

Useful future transition:

```text
discussion
→ create Planner Task draft
```

User confirms before queueing.

## 7. GPT definition

GPT is the real ChatGPT web application embedded in NightShift.

It is not a NightShift Chat.

## 8. GPT implementation timing

Decision:
- product feature retained;
- implementation follows the core Planner/Run/Worker vertical slice;
- target V1.1/core-followup.

## 9. GPT technical direction

Electron `WebContentsView` hosting:

```text
https://chatgpt.com/
```

Security:
- no Node integration;
- sandbox;
- no privileged NightShift preload;
- persistent login session partition;
- no cookie extraction;
- no private API scraping.

## 10. Local file bridge

Right local file explorer should later attempt:
- native file drag from NightShift;
- drop into ChatGPT upload area.

If cross-view drop is unreliable:
- Reveal in Explorer;
- external browser fallback.

## 11. No automatic ChatGPT project sync in V1

NightShift cannot assume public APIs for synchronizing personal ChatGPT Project source files/conversations.

Manual file transfer is the product contract until a supported API exists.
