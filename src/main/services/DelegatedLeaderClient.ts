import type { ModelDescriptor, ValidationStatus } from '@shared/domain/entities';

import type { FccGateway } from './contracts/FccGateway';

export type LeaderDecision =
  | { protocolVersion: 1; action: 'WORK'; instruction: string; summary: string }
  | { protocolVersion: 1; action: 'DONE'; summary: string }
  | { protocolVersion: 1; action: 'BLOCKED'; summary: string; blocker: string };

export interface LeaderRequest {
  protocolVersion: 1; runId: string; phase: 'initial' | 'post_attempt';
  task: { title: string; prompt: string }; worker: { agentId: string; modelId: string };
  budget: { attemptIndex: number; maxAttempts: number; remainingAttempts: number };
  attempt?: { index: number; workerResultSummary: string | null; workerFailureReason: string | null };
  evidence: { gitStatus: string; changedFiles: string[]; diff: string; diffTruncated: boolean; validationStatus: ValidationStatus; validationCommands: Array<{ command: string; status: string; exitCode: number | null; output: string; outputTruncated: boolean }>; priorAttemptSummaries: string[] };
}
export interface LeaderClient { resolveLuna(): Promise<ModelDescriptor>; decide(modelId: string, request: LeaderRequest, signal: AbortSignal): Promise<LeaderDecision>; }

const systemInstruction = `You are NightShift's Delegated Leader. You never edit code or run commands. Return exactly one JSON object and no markdown, commentary, or chain-of-thought.
Schema: {"protocolVersion":1,"action":"WORK","instruction":"non-empty concrete worker instruction","summary":"concise operational summary"} OR {"protocolVersion":1,"action":"DONE","summary":"concise operational summary"} OR {"protocolVersion":1,"action":"BLOCKED","summary":"concise operational summary","blocker":"non-empty actionable blocker"}.
WORK requires a non-empty instruction and is for another fresh Worker attempt. DONE is permitted only when deterministic validationStatus is "passed". BLOCKED is for a reason autonomous continuation is unsafe or impossible. Do not add keys.`;

export class DelegatedLeaderClient implements LeaderClient {
  public constructor(private readonly gateway: FccGateway) {}

  public async resolveLuna(): Promise<ModelDescriptor> {
    const matches = (await this.gateway.listModels()).filter(isLunaModel);
    if (matches.length !== 1) throw new Error(matches.length ? 'FCC exposes multiple routable OpenAI/ChatGPT Luna models; configure a unique Leader model.' : 'FCC exposes no routable OpenAI/ChatGPT Luna model.');
    return matches[0]!;
  }

  public async decide(modelId: string, request: LeaderRequest, signal: AbortSignal): Promise<LeaderDecision> {
    if (!this.gateway.createMessage) throw new Error('FCC Messages routing is unavailable.');
    const raw = await this.gateway.createMessage({ model: modelId, system: systemInstruction, messages: [{ role: 'user', content: JSON.stringify(request) }], max_tokens: 2048 }, signal);
    try { return parseLeaderDecision(extractText(raw)); }
    catch (error) {
      const repair = { ...request, evidence: { ...request.evidence, priorAttemptSummaries: [...request.evidence.priorAttemptSummaries, `Protocol repair required: ${error instanceof Error ? error.message : String(error)}`] } };
      const repaired = await this.gateway.createMessage({ model: modelId, system: `${systemInstruction} Your preceding answer was invalid. Return only a valid protocol JSON object.`, messages: [{ role: 'user', content: JSON.stringify(repair) }], max_tokens: 2048 }, signal);
      return parseLeaderDecision(extractText(repaired));
    }
  }
}

export const parseLeaderDecision = (raw: string): LeaderDecision => {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('Leader response is not valid JSON.'); }
  if (!record(value) || value.protocolVersion !== 1 || typeof value.action !== 'string' || typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('Leader response does not match the decision schema.');
  if (value.action === 'WORK' && typeof value.instruction === 'string' && value.instruction.trim() && Object.keys(value).every((key) => ['protocolVersion', 'action', 'instruction', 'summary'].includes(key))) return { protocolVersion: 1, action: 'WORK', instruction: value.instruction.trim(), summary: value.summary.trim() };
  if (value.action === 'DONE' && Object.keys(value).every((key) => ['protocolVersion', 'action', 'summary'].includes(key))) return { protocolVersion: 1, action: 'DONE', summary: value.summary.trim() };
  if (value.action === 'BLOCKED' && typeof value.blocker === 'string' && value.blocker.trim() && Object.keys(value).every((key) => ['protocolVersion', 'action', 'summary', 'blocker'].includes(key))) return { protocolVersion: 1, action: 'BLOCKED', summary: value.summary.trim(), blocker: value.blocker.trim() };
  throw new Error('Leader response does not match the decision schema.');
};

const extractText = (value: unknown): string => {
  if (record(value) && typeof value.content === 'string') return value.content;
  if (record(value) && Array.isArray(value.content)) { const content: unknown[] = value.content; const text = content.find((part): part is Record<string, unknown> => record(part) && part.type === 'text' && typeof part.text === 'string'); if (text && typeof text.text === 'string') return text.text; }
  throw new Error('FCC returned no textual Leader response.');
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isLunaModel = (model: ModelDescriptor): boolean => /luna/iu.test(`${model.displayName} ${model.rawModelRef}`) && /openai|chatgpt/iu.test(`${model.providerId} ${model.displayName} ${model.rawModelRef}`);
