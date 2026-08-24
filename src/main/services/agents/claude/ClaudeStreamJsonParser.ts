export interface ClaudeStreamEvent {
  rawLine: string;
  parsed: unknown;
  type: string | null;
  sessionId: string | null;
  terminal: boolean;
  parseError: string | null;
}

export class ClaudeStreamJsonParser {
  private buffered = '';
  private detectedSessionId: string | null = null;
  private detectedTerminalEvent: ClaudeStreamEvent | null = null;

  public get sessionId(): string | null {
    return this.detectedSessionId;
  }

  public get terminalEvent(): ClaudeStreamEvent | null {
    return this.detectedTerminalEvent;
  }

  public push(chunk: string): ClaudeStreamEvent[] {
    this.buffered += chunk;
    const lines = this.buffered.split(/\r?\n/u);
    this.buffered = lines.pop() ?? '';
    return lines.flatMap((line) => line ? [this.parseLine(line)] : []);
  }

  public finish(): ClaudeStreamEvent[] {
    if (!this.buffered) return [];
    const remaining = this.buffered;
    this.buffered = '';
    return [this.parseLine(remaining)];
  }

  private parseLine(rawLine: string): ClaudeStreamEvent {
    try {
      const parsed: unknown = JSON.parse(rawLine);
      const type = stringField(parsed, 'type');
      const sessionId = stringField(parsed, 'session_id');
      let parseError: string | null = null;
      if (sessionId && this.detectedSessionId && sessionId !== this.detectedSessionId) {
        parseError = `Conflicting Claude session_id: ${sessionId}`;
      } else if (sessionId) {
        this.detectedSessionId = sessionId;
      }
      const event: ClaudeStreamEvent = {
        rawLine,
        parsed,
        type,
        sessionId,
        terminal: type === 'result',
        parseError,
      };
      if (event.terminal) this.detectedTerminalEvent = event;
      return event;
    } catch (error) {
      return {
        rawLine,
        parsed: null,
        type: null,
        sessionId: null,
        terminal: false,
        parseError: error instanceof Error ? error.message : 'Invalid Claude stream JSON.',
      };
    }
  }
}

const stringField = (value: unknown, field: string): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate ? candidate : null;
};
