// ---------------------------------------------------------------------------
// Pipeline gates -- whether a stage may run, and what clears it when not.
// ---------------------------------------------------------------------------

import type { EpisodeFacts } from './status.js';

/**
 * The script-approval gate. `storyboard-episode` accepts either marker:
 * `approve-script` writes the artifact, `workshop --approve` only sets the
 * script's status (rule 45 — checking only the file told every
 * workshop-driven project to re-approve a script it had already shot).
 */
export function scriptApproved(facts: Pick<EpisodeFacts, 'scriptApprovalArtifact' | 'scriptStatusApproved'>): boolean {
  return facts.scriptApprovalArtifact || facts.scriptStatusApproved;
}
