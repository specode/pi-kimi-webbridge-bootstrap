# Agent Guide

This repository is a thin Pi-side bootstrap proxy for installing and updating Kimi WebBridge.

- Keep official WebBridge binaries and skills out of Git. Fetch them only from `https://cdn.kimi.com/webbridge`.
- Preserve update safety: verify binary SHA-256, validate archive paths and entry types, stage downloads, and atomically replace the active skill.
- A failed update must leave the previous CLI and skill usable and must not block Pi when a cached skill exists.
- Do not add browser-control tools here. The official skill owns the HTTP command contract.
- Run `npm test` and `npm run check` after changes.
