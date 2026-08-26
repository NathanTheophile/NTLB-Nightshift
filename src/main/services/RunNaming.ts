const MAX_RUN_NAME_LENGTH = 64;

export const readableRunSlug = (title: string): string => {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_RUN_NAME_LENGTH).replace(/-+$/g, '');
  return slug || 'run';
};

export const readableRunNameWithSuffix = (base: string, ordinal: number): string => {
  if (ordinal <= 1) return base;
  const suffix = `-${ordinal}`;
  const prefix = base.slice(0, Math.max(1, MAX_RUN_NAME_LENGTH - suffix.length)).replace(/-+$/g, '') || 'run';
  return `${prefix}${suffix}`;
};

export const candidateBranchForRunName = (runName: string): string => `nightshift/run/${runName}`;
