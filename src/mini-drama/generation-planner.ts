import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GenerationPlan } from 'venice-video-harness/core/series/types.js';
import { parseShotDuration } from 'venice-video-harness/core/series/duration.js';

// The planner itself is pure and lives in core; this module keeps the
// generation-plan.json IO and re-exports the rest for its existing importers.
export {
  buildGenerationPlan,
  mustRenderAsExactLipSync,
  mustStayAsWanLipSync,
  shouldUseSeedanceKeyframe,
} from 'venice-video-harness/core/mini-drama/generation-planner.js';

// Moved to core so browser hosts can read `"5s"` strings; kept on this module
// for its existing importers (prompt-builder, montage, video-generator).
export { parseShotDuration };

export async function saveGenerationPlan(episodeDir: string, plan: GenerationPlan): Promise<string> {
  const planPath = join(episodeDir, 'generation-plan.json');
  await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
  return planPath;
}

export async function loadGenerationPlan(episodeDir: string): Promise<GenerationPlan | null> {
  const planPath = join(episodeDir, 'generation-plan.json');
  if (!existsSync(planPath)) return null;
  const raw = await readFile(planPath, 'utf-8');
  return JSON.parse(raw) as GenerationPlan;
}
