import type { Location, SeriesState } from './types.js';

/** Find a location by slug (preferred) or display name. */
export function getLocation(series: SeriesState, slugOrName: string): Location | undefined {
  const needle = slugOrName.toLowerCase();
  return (series.locations ?? []).find(
    l => l.slug.toLowerCase() === needle || l.name.toLowerCase() === needle,
  );
}
