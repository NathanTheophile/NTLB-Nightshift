export interface CodexJsonlEvent {
  rawLine: string;
  parsed: unknown;
  type: string | null;
  threadId: string | null;
  terminal: boolean;
  parseError: string | null;
}

export class CodexJsonlParser {
  private buffered = '';
  private detectedThreadId: string | null = null;
  private detectedTerminalEvent: CodexJsonlEvent | null = null;

  public get threadId(): string | null { return this.detectedThreadId; }
  public get terminalEvent(): CodexJsonlEvent | null { return this.detectedTerminalEvent; }

  public push(chunk: string): CodexJsonlEvent[] {
    this.buffered += chunk;
    const lines = this.buffered.split(/\r?\n/u);
    this.buffered = lines.pop() ?? '';
    return lines.flatMap((line) => line ? [this.parseLine(line)] : []);
  }

  public finish(): CodexJsonlEvent[] {
    if (!this.buffered) return [];
    const line = this.buffered;
    this.buffered = '';
    return [this.parseLine(line)];
  }

  private parseLine(rawLine: string): CodexJsonlEvent {
    try {
      const parsed: unknown = JSON.parse(rawLine);
      const type = stringField(parsed, 'type');
      const threadId = findThreadId(parsed);
      let parseError: string | null = null;
      if (threadId && this.detectedThreadId && threadId !== this.detectedThreadId) {
        parseError = `Conflicting Codex thread_id: ${threadId}`;
      } else if (threadId) {
        this.detectedThreadId = threadId;
      }
      const event = { rawLine, parsed, type, threadId, terminal: type === 'turn.completed', parseError };
      if (event.terminal) this.detectedTerminalEvent = event;
      return event;
    } catch (error) {
      return { rawLine, parsed: null, type: null, threadId: null, terminal: false, parseError: error instanceof Error ? error.message : 'Invalid Codex JSONL.' };
    }
  }
}

const stringField = (value: unknown, field: string): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
};

const findThreadId = (value: unknown, depth = 0): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return null;
  const record = value as Record<string, unknown>;
  for (const field of ['thread_id', 'threadId']) {
    const id = stringField(record, field);
    if (id) return id;
  }
  for (const nested of Object.values(record)) {
    const id = findThreadId(nested, depth + 1);
    if (id) return id;
  }
  return null;
};
