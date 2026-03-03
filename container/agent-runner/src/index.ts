/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { Codex, Thread, ThreadOptions } from '@openai/codex-sdk';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function getConfiguredModel(): string | undefined {
  const model = process.env.CODEX_MODEL?.trim();
  return model && model.length > 0 ? model : undefined;
}

function isModelNotFoundError(message: string): boolean {
  return /model_not_found|requested model.+does not exist/i.test(message);
}

function extractMissingModel(message: string): string | undefined {
  const match = message.match(/requested model '([^']+)'/i);
  return match?.[1];
}

function createThread(
  codex: Codex,
  sessionId?: string,
  model?: string,
): Thread {
  const options: ThreadOptions = {
    workingDirectory: '/workspace/group',
    sandboxMode: 'workspace-write',
    skipGitRepoCheck: true,
    model,
  };

  if (sessionId) {
    return codex.resumeThread(sessionId, options);
  }

  return codex.startThread(options);
}

function ensurePlaywrightMcpConfigured(): void {
  if (process.env.NANOCLAW_PLAYWRIGHT_MCP === '0') {
    log('Playwright MCP disabled via NANOCLAW_PLAYWRIGHT_MCP=0');
    return;
  }

  try {
    execFileSync('codex', ['mcp', 'get', 'playwright'], {
      stdio: 'ignore',
    });
    return;
  } catch {
    // Not configured yet.
  }

  try {
    execFileSync(
      'codex',
      [
        'mcp',
        'add',
        'playwright',
        '--',
        'playwright-mcp',
        '--headless',
        '--browser',
        'chrome',
        '--executable-path',
        '/usr/bin/chromium',
      ],
      { stdio: 'pipe' },
    );
    log('Configured Codex MCP server: playwright');
  } catch (err) {
    log(
      `Failed to configure Playwright MCP: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runTurn(thread: Thread, prompt: string): Promise<string | null> {
  const turn = await thread.run(prompt);
  const result = turn.finalResponse?.trim();
  return result && result.length > 0 ? result : null;
}

function resolveCodexPathOverride(): string | undefined {
  const explicit = process.env.CODEX_PATH_OVERRIDE?.trim();
  if (explicit) return explicit;

  // Prefer the globally installed Codex CLI in this container.
  // The SDK-bundled binary can hit Landlock restrictions in some Docker setups.
  const globalCodex = '/usr/local/bin/codex';
  return fs.existsSync(globalCodex) ? globalCodex : undefined;
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  const authPath = '/home/node/.codex/auth.json';
  if (!fs.existsSync(authPath)) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'Codex authentication missing. Run `codex login` on the host, then retry.',
    });
    process.exit(1);
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
  }

  ensurePlaywrightMcpConfigured();

  const codexPathOverride = resolveCodexPathOverride();
  if (codexPathOverride) {
    log(`Using Codex binary override: ${codexPathOverride}`);
  }
  const codex = new Codex(
    codexPathOverride ? { codexPathOverride } : undefined,
  );
  const configuredModel = getConfiguredModel();
  let usingDefaultModel = !configuredModel;
  let thread = createThread(codex, containerInput.sessionId, configuredModel);
  let sessionId = containerInput.sessionId;

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      if (shouldClose()) {
        log('Close sentinel received before turn start, exiting');
        break;
      }

      log(`Starting Codex turn (thread: ${sessionId || 'new'})`);

      const result = await runTurn(thread, prompt);
      if (thread.id) {
        sessionId = thread.id;
      }

      if (result !== null) {
        writeOutput({
          status: 'success',
          result,
          newSessionId: sessionId,
        });
      }

      if (shouldClose()) {
        log('Close sentinel received after turn, exiting');
        break;
      }

      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
      });

      log('Turn ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      prompt = nextMessage;
      log(`Received follow-up message (${prompt.length} chars)`);
    }
  } catch (err) {
    let errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);

    if (isModelNotFoundError(errorMessage)) {
      const unavailableModel = extractMissingModel(errorMessage);
      const fallbackCandidates = [
        undefined,
        process.env.CODEX_FALLBACK_MODEL?.trim(),
        configuredModel,
        'gpt-5.3-codex',
        'gpt-5-codex',
        'gpt-5',
      ];
      const attempted = new Set<string>();
      let nonModelError: string | null = null;

      for (const candidate of fallbackCandidates) {
        if (candidate === '') continue;
        if (candidate && unavailableModel && candidate === unavailableModel) {
          continue;
        }
        const key = candidate ?? '__default__';
        if (attempted.has(key)) continue;
        attempted.add(key);

        const candidateName = candidate ?? 'SDK default';
        try {
          log(`Retrying after model_not_found with ${candidateName}`);
          usingDefaultModel = candidate === undefined;
          thread = createThread(codex, sessionId, candidate);
          const result = await runTurn(thread, prompt);
          sessionId = thread.id || sessionId;
          writeOutput({
            status: 'success',
            result,
            newSessionId: sessionId,
          });
          return;
        } catch (fallbackErr) {
          const fallbackMessage =
            fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          log(`Model retry failed (${candidateName}): ${fallbackMessage}`);
          if (!isModelNotFoundError(fallbackMessage)) {
            nonModelError = fallbackMessage;
            break;
          }
        }
      }

      if (nonModelError) {
        errorMessage = nonModelError;
      } else {
        const attemptedModels = Array.from(attempted)
          .map((m) => (m === '__default__' ? 'SDK default' : m))
          .join(', ');
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: `Model fallback exhausted for unavailable model "${unavailableModel || 'unknown'}". Attempted: ${attemptedModels}`,
        });
        process.exit(1);
        return;
      }
    }

    // If resume fails, try one recovery with a new thread.
    if (sessionId && /thread|resume|not found|missing/i.test(errorMessage)) {
      try {
        log('Attempting recovery by starting a new thread');
        thread = createThread(
          codex,
          undefined,
          usingDefaultModel ? undefined : configuredModel,
        );
        const result = await runTurn(thread, prompt);
        sessionId = thread.id || sessionId;
        writeOutput({
          status: 'success',
          result,
          newSessionId: sessionId,
        });
        return;
      } catch (recoveryErr) {
        const recoveryMessage =
          recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: `Recovery failed: ${recoveryMessage}`,
        });
        process.exit(1);
        return;
      }
    }

    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
