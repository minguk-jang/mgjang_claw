# NanoClaw Codex + OpenAI OAuth Migration Plan (2026-03-02)

## Goal
Switch NanoClaw from Claude Agent SDK to Codex with OpenAI OAuth, with minimal code changes while keeping the existing WhatsApp/container/queue architecture.

## Scope
- In scope
1. Container-side agent engine migration to Codex.
2. OpenAI OAuth auth path via host `~/.codex` mount.
3. Keep existing container input/output protocol and session field usage.

- Out of scope (phase 1)
1. `mcp__nanoclaw__*` tools parity.
2. Claude-specific hooks/tool policies.
3. Agent teams parity.

## Implementation Plan
1. Replace Claude SDK dependency in `container/agent-runner` with Codex SDK.
2. Rewrite `container/agent-runner/src/index.ts` to use `@openai/codex-sdk` thread API.
3. Update `container/Dockerfile` to install Codex CLI globally.
4. Replace secret forwarding in `src/container-runner.ts` with a readonly mount of `~/.codex` to `/home/node/.codex`.
5. Update setup verification to validate Codex OAuth cache instead of Claude tokens.
6. Update setup docs/messages with Codex auth instructions.
7. Update user-facing WhatsApp auth error text to neutral setup wording.

## Acceptance Criteria
1. The agent container can run Codex turns and return text responses.
2. `newSessionId` is preserved as Codex thread id for follow-up turns.
3. Missing Codex auth is surfaced as a clear runtime error.
4. Existing queue/container lifecycle remains unchanged.

## Execution Notes
- No repo-wide refactor.
- No tests executed in this pass.
- Keep changes minimal and localized.
