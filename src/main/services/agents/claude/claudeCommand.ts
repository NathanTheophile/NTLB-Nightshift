import type { RunStartSpec, WorkerStartSpec } from '../../contracts/AgentAdapter';

const boundedFileEditTools = 'Read,Edit,Write,Glob,Grep';

export const buildClaudeRunArguments = (spec: RunStartSpec): readonly string[] => {
  if (!spec.modelId.trim()) throw new Error('Claude runs require an explicit model.');
  if (!spec.prompt.trim()) throw new Error('Claude runs require a non-empty prompt.');
  if (!spec.workingDirectory.trim()) throw new Error('Claude runs require an explicit working directory.');

  return [
    '-p',
    '--verbose',
    '--model',
    spec.modelId,
    '--permission-mode',
    'acceptEdits',
    '--tools',
    boundedFileEditTools,
    '--output-format',
    'stream-json',
    spec.prompt,
  ];
};

export const buildClaudeWorkerArguments = (spec: WorkerStartSpec): readonly string[] => {
  if (!spec.modelId.trim()) throw new Error('Claude Workers require an explicit model.');
  if (!spec.prompt.trim()) throw new Error('Claude Workers require a non-empty message.');
  if (!spec.workingDirectory.trim()) throw new Error('Claude Workers require an explicit working directory.');

  const readOnly = spec.permissionProfile === 'read_only';
  return [
    '-p',
    '--verbose',
    '--model',
    spec.modelId,
    '--permission-mode',
    readOnly ? 'plan' : 'acceptEdits',
    '--tools',
    readOnly ? 'Read,Glob,Grep' : boundedFileEditTools,
    '--output-format',
    'stream-json',
    ...(spec.externalSessionId ? ['--resume', spec.externalSessionId] : []),
    spec.prompt,
  ];
};
