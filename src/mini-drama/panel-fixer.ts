import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { VeniceClient } from '../venice/client.js';
import type { MultiEditModel } from 'venice-video-harness/core/venice/types.js';
import { multiEditImage, loadImageAsDataUri } from '../venice/multi-edit.js';
import type { SeriesState, ShotScript, ShotEnvironment, MiniDramaCharacter } from 'venice-video-harness/core/series/types.js';
import { DEFAULT_IMAGE_EDIT_MODEL } from 'venice-video-harness/core/series/types.js';
import { buildStyleMatchPrompt, planCharacterFix, type CharacterFixReference } from 'venice-video-harness/core/mini-drama/storyboard-panels.js';
import { getCharacterDir } from '../series/manager.js';
import { appendRecipePass } from '../venice/recipe.js';
// Multi-edit post-processing (WebP fix + 1:1→target aspect restore) is shared
// with the reference-drafted panel path; see src/venice/edit-post.ts. The
// 16:9 close-up crop warning documented there applies to every caller here.
import { ensureRealPng, restoreAspectRatio, getImageDimensions } from '../venice/edit-post.js';

export async function fixPanel(
  client: VeniceClient,
  series: SeriesState,
  panelPath: string,
  characterNames: string[],
  model?: MultiEditModel,
  customPrompt?: string,
  episodeWardrobe?: Record<string, string>,
  environment?: ShotEnvironment,
  environmentRefPath?: string,
): Promise<string> {
  await ensureRealPng(panelPath);

  const origDims = getImageDimensions(panelPath);
  const origW = origDims ? origDims[0] : 0;
  const origH = origDims ? origDims[1] : 0;

  const panelDataUri = await loadImageAsDataUri(panelPath);

  const chars = characterNames
    .map(name => series.characters.find(c => c.name.toUpperCase() === name.toUpperCase()))
    .filter((c): c is MiniDramaCharacter => c !== undefined);

  if (chars.length === 0) {
    throw new Error(`No matching characters found for: ${characterNames.join(', ')}`);
  }

  // Multi-edit accepts up to 3 images total (base + 2 refs): characters first,
  // a location environment ref (when provided) takes the last free slot.
  const wantLocationRef = Boolean(environmentRefPath) && existsSync(environmentRefPath!);
  const referencesOf = (char: MiniDramaCharacter): CharacterFixReference => {
    const charDir = getCharacterDir(series, char.name);
    // anchor.png (harvested from an approved render) outranks the generated
    // sheets — same precedence as the reference-slot allocator and the
    // reference-drafting path. Requiring front.png specifically made the
    // whole refinement throw when only anchor/three-quarter existed — one
    // of the "sometimes references aren't used" intermittency sources.
    const primaryPath = ['anchor.png', 'front.png', 'three-quarter.png']
      .map(f => join(charDir, f))
      .find(p => existsSync(p));
    if (!primaryPath) {
      throw new Error(`No reference image found for ${char.name} in ${charDir} (looked for anchor.png, front.png, three-quarter.png)`);
    }
    const secondAngle = ['three-quarter.png', 'profile.png', 'full-body.png']
      .map(f => join(charDir, f))
      .find(p => existsSync(p) && p !== primaryPath);
    return { primary: primaryPath, ...(secondAngle ? { secondAngle } : {}) };
  };
  const plan = planCharacterFix({
    characters: chars,
    referencesOf,
    ...(wantLocationRef ? { environmentRef: environmentRefPath! } : {}),
    customPrompt,
    episodeWardrobe,
    environment,
  });
  if (plan.locationDropped) {
    console.warn('  ⚠ Location environment ref dropped: character refs fill the multi-edit slot budget (2+ characters).');
  }
  const { prompt } = plan;
  const charRefPaths = plan.references;
  const charRefs: string[] = [];
  for (const path of charRefPaths) charRefs.push(await loadImageAsDataUri(path));

  // Warn about 16:9 close-ups losing forehead/chin after 1:1→16:9 crop
  if (origW > origH && origW / origH > 1.5) {
    console.warn('  ⚠ Multi-editing a 16:9 panel — the 1:1→16:9 crop will remove ~25% from top/bottom.');
    console.warn('    Close-up face shots may lose foreheads. Consider generating from scratch instead.');
  }

  console.log(`  Multi-editing panel with ${chars.length} character reference(s)...`);
  console.log(`  Model: ${model || DEFAULT_IMAGE_EDIT_MODEL}`);

  const resultBuffer = await multiEditImage(client, {
    model,
    prompt,
    baseImage: panelDataUri,
    referenceImages: charRefs,
  });

  let archivedPrevious: string | undefined;
  if (existsSync(panelPath)) {
    archivedPrevious = panelPath.replace(/\.png$/, '-pre-fix.png');
    await rename(panelPath, archivedPrevious);
    console.log(`  Archived original: ${archivedPrevious}`);
  }

  await writeFile(panelPath, resultBuffer);

  // Restore original aspect ratio (multi-edit always returns 1024x1024)
  if (origW > 0 && origH > 0) {
    await restoreAspectRatio(panelPath, origW, origH);
  }

  // Record the edit in the panel's recipe + provenance sidecars so a
  // finishing agent can replay the pass and the Seedance pre-flight gate
  // can tell whether the panel is still compatible. fixPanel is always
  // called with at least one character reference, so the panel now
  // contains a human face.
  const editModelUsed = model ?? DEFAULT_IMAGE_EDIT_MODEL;
  await appendRecipePass(panelPath, {
    kind: 'multi-edit',
    role: 'identity',
    model: editModelUsed,
    label: 'character refine',
    prompt,
    referenceImagePaths: charRefPaths,
    archivedPrevious,
    extra: {
      ...(origW > 0 && origH > 0
        ? { aspectRestore: `1024x1024 -> ${origW}x${origH} center crop + scale` }
        : {}),
      // Same summary shape as reference-draft.ts — the web UI's per-shot
      // badge reads the LAST referenceUsage in the recipe, so a repair pass
      // supersedes the draft's record.
      referenceUsage: {
        base: 'panel',
        anchored: plan.anchored,
        textOnly: plan.textOnly,
      },
    },
  }, { provenance: 'edit', hasFace: true });

  console.log(`  Fixed panel saved: ${panelPath}`);
  return panelPath;
}

export async function refineWithReferences(
  client: VeniceClient,
  series: SeriesState,
  panelPath: string,
  shot: ShotScript,
  model?: MultiEditModel,
  environmentRefPath?: string,
): Promise<string> {
  if (shot.characters.length === 0) return panelPath;
  return fixPanel(client, series, panelPath, shot.characters, model, undefined, shot.episodeWardrobe, shot.environment, environmentRefPath);
}

/**
 * Refine a panel's aesthetic to match a style anchor image.
 * Used for shots without characters (establishing, insert, title cards)
 * to maintain visual consistency with the rest of the episode.
 */
export async function refineStyleConsistency(
  client: VeniceClient,
  panelPath: string,
  styleAnchorPath: string,
  aesthetic: string,
  model?: MultiEditModel,
  environment?: ShotEnvironment,
): Promise<string> {
  await ensureRealPng(panelPath);
  const origDims = getImageDimensions(panelPath);
  const origW = origDims ? origDims[0] : 0;
  const origH = origDims ? origDims[1] : 0;

  const panelDataUri = await loadImageAsDataUri(panelPath);
  const anchorDataUri = await loadImageAsDataUri(styleAnchorPath);

  const prompt = buildStyleMatchPrompt(aesthetic, environment);

  console.log(`  Style-matching panel against anchor image...`);

  const resultBuffer = await multiEditImage(client, {
    model,
    prompt,
    baseImage: panelDataUri,
    referenceImages: [anchorDataUri],
  });

  let archivedPrevious: string | undefined;
  if (existsSync(panelPath)) {
    archivedPrevious = panelPath.replace(/\.png$/, '-pre-style.png');
    await rename(panelPath, archivedPrevious);
  }

  await writeFile(panelPath, resultBuffer);

  if (origW > 0 && origH > 0) {
    await restoreAspectRatio(panelPath, origW, origH);
  }

  // Style refinement explicitly preserves no-character panels (hasFace:false).
  const editModelUsed = model ?? DEFAULT_IMAGE_EDIT_MODEL;
  await appendRecipePass(panelPath, {
    kind: 'multi-edit',
    role: 'look',
    model: editModelUsed,
    label: 'style match',
    prompt,
    referenceImagePaths: [styleAnchorPath],
    archivedPrevious,
    extra: origW > 0 && origH > 0
      ? { aspectRestore: `1024x1024 -> ${origW}x${origH} center crop + scale` }
      : undefined,
  }, { provenance: 'edit', hasFace: false });

  console.log(`  Style-matched panel saved: ${panelPath}`);
  return panelPath;
}
