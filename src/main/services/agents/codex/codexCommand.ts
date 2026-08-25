import type { RunStartSpec } from '../../contracts/AgentAdapter';

/** The FCC 5.14.2 Codex headless contract validated for Planner runs. */
export const buildCodexRunArguments = (spec: RunStartSpec): readonly string[] => {
  if (!spec.modelId.trim()) throw new Error('Codex runs require an explicit model.');
  if (!spec.prompt.trim()) throw new Error('Codex runs require a non-empty prompt.');
  if (!spec.workingDirectory.trim()) throw new Error('Codex runs require an explicit working directory.');

  return ['exec', '-C', spec.workingDirectory, '-m', spec.modelId, '-s', 'workspace-write', '--json', spec.prompt];
};
