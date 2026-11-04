/**
 * Corner radius and spacing density: small enums the model (or a person)
 * chooses from, mapped to theme.json presets. The slugs are the Pressbase
 * theme's (`settings.border.radiusSizes`) and WordPress's spacing scale
 * (`settings.spacing.spacingSizes`, 20–80), so patterns that use the
 * presets follow the choice without changing.
 */

export const RADII = ['square', 'subtle', 'rounded', 'soft'] as const;
export type Radius = (typeof RADII)[number];

export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];

export interface RadiusPreset {
  name: string;
  slug: string;
  size: string;
}

export interface SpacingPreset {
  name: string;
  slug: string;
  size: string;
}

const RADIUS_NAMES = { sm: 'Small', md: 'Medium', lg: 'Large', xl: 'Extra Large', full: 'Full' };

/**
 * Sizes per choice for the Pressbase theme's radius slugs. `full` is what
 * buttons and pills use: a pill except with square or subtle corners,
 * where buttons match the rest.
 */
const RADIUS_SIZES: Record<Radius, Record<keyof typeof RADIUS_NAMES, string>> = {
  square: { sm: '0', md: '0', lg: '0', xl: '0', full: '0' },
  subtle: { sm: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', full: '0.375rem' },
  rounded: { sm: '0.5rem', md: '0.875rem', lg: '1.25rem', xl: '2rem', full: '999px' },
  soft: { sm: '0.75rem', md: '1.25rem', lg: '1.75rem', xl: '2.75rem', full: '999px' },
};

export function radiusPresets(radius: Radius): RadiusPreset[] {
  const sizes = RADIUS_SIZES[radius];
  if (!sizes) throw new Error(`Unknown radius: ${String(radius)}`);
  return (Object.keys(RADIUS_NAMES) as (keyof typeof RADIUS_NAMES)[]).map((slug) => ({
    name: RADIUS_NAMES[slug],
    slug,
    size: sizes[slug],
  }));
}

/** The Pressbase theme's scale ("comfortable"): fixed steps, then fluid ones. */
const SPACING_SCALE: { slug: string; name: string; min: number; vw?: number; max?: number }[] = [
  { slug: '20', name: 'Tiny', min: 0.5 },
  { slug: '30', name: 'X-Small', min: 1 },
  { slug: '40', name: 'Small', min: 1.5 },
  { slug: '50', name: 'Regular', min: 1.5, vw: 4, max: 2.5 },
  { slug: '60', name: 'Large', min: 2.5, vw: 6, max: 4 },
  { slug: '70', name: 'X-Large', min: 3.5, vw: 8, max: 6 },
  { slug: '80', name: 'XX-Large', min: 4.5, vw: 11, max: 8.5 },
];

const DENSITY_FACTOR: Record<Density, number> = { compact: 0.75, comfortable: 1, spacious: 1.3 };

const rem = (value: number) => `${Number(value.toFixed(3))}rem`;

export function spacingPresets(density: Density): SpacingPreset[] {
  const factor = DENSITY_FACTOR[density];
  if (!factor) throw new Error(`Unknown density: ${String(density)}`);
  return SPACING_SCALE.map(({ slug, name, min, vw, max }) => ({
    name,
    slug,
    size:
      vw && max
        ? `clamp(${rem(min * factor)}, ${Number((vw * factor).toFixed(2))}vw, ${rem(max * factor)})`
        : rem(min * factor),
  }));
}

/** The gap between blocks (`styles.spacing.blockGap`) for a density. */
export function blockGap(density: Density): string {
  return rem(1.25 * DENSITY_FACTOR[density]);
}
