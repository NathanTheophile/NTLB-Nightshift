# FCC Current Facts Snapshot — 2026-08-24

This file is **external-fact context**, not NightShift product authority.

Sources checked:
- FCC README
- FCC ARCHITECTURE.md
- FCC pyproject.toml

Repository:
https://github.com/Alishahryar1/free-claude-code

Observed current README claims:
- 48 ToS-friendly providers;
- 1.3B+ free tokens/month across provider offerings, subject to provider changes;
- seven coding agents sharing one model catalog:
  Claude Code, Codex, Pi, OpenCode, Cline, Hermes, DeepSeek Harness.

Observed launcher scripts in current project metadata:
- fcc-server
- fcc-claude
- fcc-codex
- fcc-pi
- fcc-opencode
- fcc-cline
- fcc-hermes
- fcc-dsh

Architecture principle stated by FCC:
- API owns compatibility filtering/direct wire identity;
- launchers translate FCC catalog/config into client-specific formats.

NightShift must re-check this information during implementation because FCC is fast-moving.
