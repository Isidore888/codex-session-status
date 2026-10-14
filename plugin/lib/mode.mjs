// Exact local metadata values verified on this client. No model or process-name inference.
export function identifyMode(originator) {
  if (originator === 'Codex Desktop') return 'Codex';
  if (originator === 'codex_work_desktop') return 'Work';
  return null;
}

export function mergeModes(values) {
  const known = new Set(values.filter((value) => value === 'Codex' || value === 'Work'));
  return known.size === 1 ? [...known][0] : null;
}
