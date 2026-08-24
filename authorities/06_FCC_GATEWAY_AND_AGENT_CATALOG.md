# 06 — FCC Gateway and Agent Catalog

## 1. V1 decision

FCC is a **mandatory central dependency** in NightShift V1.

This is intentional.

NightShift V1 will not maintain parallel direct provider integrations.

## 2. Why FCC

FCC currently provides the exact infrastructure NightShift needs:
- one model/provider catalog;
- multiple provider types;
- coding-agent launchers;
- protocol translation;
- compatibility filtering;
- current-settings management;
- a local gateway/server.

NightShift should leverage this instead of rebuilding it.

## 3. Current external fact snapshot — 2026-08-24

The public FCC README currently advertises:
- 48 ToS-friendly providers;
- 1.3B+ free tokens/month across providers, subject to provider limits;
- seven coding agents in the current README:
  - Claude Code;
  - Codex;
  - Pi;
  - OpenCode;
  - Cline;
  - Hermes;
  - DeepSeek Harness.

The current Python project exposes launcher scripts including:
- `fcc-claude`;
- `fcc-codex`;
- `fcc-pi`;
- `fcc-opencode`;
- `fcc-cline`;
- `fcc-hermes`;
- `fcc-dsh`.

This list is **not a NightShift constant**. FCC evolves.

References:
- https://github.com/Alishahryar1/free-claude-code
- https://github.com/Alishahryar1/free-claude-code/blob/main/ARCHITECTURE.md
- https://github.com/Alishahryar1/free-claude-code/blob/main/pyproject.toml

## 4. NightShift integration contract

NightShift should own an `FccGateway` service.

Responsibilities:
- detect FCC installation;
- locate launchers;
- detect/start/stop server if NightShift owns the process;
- health check;
- read available model catalog where supported;
- surface provider/model state;
- expose FCC errors clearly;
- never silently fall back to an unrelated model/provider.

## 5. FCC process ownership

If FCC is already running when NightShift starts:
- attach to it;
- do not kill it on NightShift exit.

If NightShift starts FCC:
- mark process ownership;
- stop only if configured/appropriate.

## 6. Agent discovery

NightShift should not ship a static list and assume all agents exist.

Discovery can combine:
- known `fcc-*` launcher conventions;
- FCC current metadata if exposed;
- PATH detection;
- version/help probes.

The agent appears in UI only when detection has enough evidence.

## 7. Model catalog

The model dropdown should come from FCC's routable model catalog, filtered by the selected coding agent's compatibility/capability information where available.

NightShift should not manually maintain NVIDIA/Kimi/GLM/etc. catalogs.

## 8. Compatibility

“Any agent × any model” is not an authority.

The authority is:

> **NightShift exposes any detected FCC coding agent with any model that FCC + that agent path can actually run and that NightShift can validate for the requested execution mode.**

This distinction prevents invalid combinations.

## 9. FCC configuration UI

Long-term V1 direction:
- NightShift may expose convenient FCC status/model/provider settings;
- but should not duplicate the entire FCC Admin UI immediately.

First vertical slice:
- health;
- detected agents;
- available models;
- selected model;
- run.

Provider credential management can remain in FCC Admin initially.

## 10. Failure behavior

Examples:
- FCC offline → Run does not start, Task remains actionable/blocked.
- model missing → validation error before process launch.
- launcher missing → Agent disabled.
- provider quota failure → Run records provider failure; no hidden paid fallback.
- model compatibility failure → pair marked unsupported/failed validation.

## 11. Paid API scope

Official V1 does not require paid OpenAI or Anthropic API usage.

If FCC itself can technically connect such providers, NightShift does not need to prevent the user from configuring FCC externally, but:
- NightShift V1 does not build paid-provider billing UX;
- no product behavior should require paid credits;
- benchmark defaults should use intended free/subscription/local routes.
