import type { GlobalStylesConfig } from '@pressbase/theme-json';
import { AbilityError } from '../abilities/registry';
import type { Kernel } from '../kernel';
import {
  CHECK_RULES,
  type CheckRule,
  checkPage,
  type PageFinding,
  pageStylesFromThemeJson,
} from './check-page';

/**
 * `core/check-page`: the quality checks as an ability, so the site-building
 * pipeline, Studio's checklist, the CLI and outside agents run the same
 * checks with the same permission check. REST: `/wp-abilities/v1/abilities/core/check-page/run`
 * and `POST /pressbase/v1/check-page`. See docs/architecture/quality-checks.md.
 */

export interface CheckPageInput {
  /** Block markup to check. */
  content?: string;
  /** Or a post's or page's ID: its saved content is checked. */
  id?: number;
  /**
   * User global styles to check against instead of the saved ones (a design
   * not yet published, as the pipeline or a changeset has it).
   */
  global_styles?: Record<string, unknown>;
  /** Whether the template shows the title as the page's h1. */
  title_is_h1?: boolean;
  rules?: CheckRule[];
}

export interface CheckPageOutput {
  findings: PageFinding[];
  errors: number;
  warnings: number;
  /** No errors (warnings are for a person to decide). */
  passed: boolean;
}

/** Runs the checks for the ability and the REST route. Permissions are the caller's. */
export async function runCheckPage(
  kernel: Kernel,
  input: CheckPageInput,
): Promise<CheckPageOutput> {
  let content = input.content;
  if (content === undefined) {
    const post = input.id ? await kernel.posts.get(input.id) : undefined;
    if (!post) throw new AbilityError('rest_post_invalid_id', 'Invalid post ID.', 404);
    content = post.content;
  }
  const theme = input.global_styles
    ? await kernel.themes.withUserStyles(input.global_styles as GlobalStylesConfig)
    : await kernel.themes.active();
  const findings = checkPage(content, pageStylesFromThemeJson(theme.themeJson.tree.getRawData()), {
    blockTypes: kernel.blocks.registry,
    titleIsH1: input.title_is_h1,
    i18n: kernel.i18n,
    rules: input.rules,
  });
  const errors = findings.filter((f) => f.severity === 'error').length;
  return { findings, errors, warnings: findings.length - errors, passed: errors === 0 };
}

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    rule: { type: 'string', enum: [...CHECK_RULES] },
    severity: { type: 'string', enum: ['error', 'warning'] },
    message: { type: 'string' },
    block: {
      type: ['object', 'null'],
      properties: {
        path: { type: 'array', items: { type: 'integer', minimum: 0 } },
        name: { type: ['string', 'null'] },
      },
    },
    data: { type: 'object' },
  },
  required: ['rule', 'severity', 'message', 'block'],
};

export const CHECK_PAGE_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      maxLength: 2_000_000,
      description: 'Block markup to check. Give this or id.',
    },
    id: {
      type: 'integer',
      minimum: 1,
      description: 'The ID of a post or page whose saved content is checked.',
    },
    global_styles: {
      type: 'object',
      description:
        'User global styles to check against instead of the saved ones, such as a design not yet published.',
    },
    title_is_h1: {
      type: 'boolean',
      description:
        'Whether the page template shows the title as its h1. Then the content must not have another; when false, it must have one.',
    },
    rules: {
      type: 'array',
      items: { type: 'string', enum: [...CHECK_RULES] },
      uniqueItems: true,
      description: 'Only these checks. All by default.',
    },
  },
  additionalProperties: false,
} as const;

export function registerCheckPageAbility(kernel: Kernel): void {
  kernel.abilities.register('core/check-page', {
    label: 'Check a page',
    description:
      'Checks a page’s blocks for problems: invalid or unknown blocks, text colours below WCAG AA contrast, more than one h1 or skipped heading levels, images without alt text, unfilled placeholders, vague link text and colours outside the site’s presets. Each finding names its block.',
    category: 'site',
    inputSchema: CHECK_PAGE_INPUT_SCHEMA,
    outputSchema: {
      type: 'object',
      properties: {
        findings: { type: 'array', items: FINDING_SCHEMA },
        errors: { type: 'integer', minimum: 0 },
        warnings: { type: 'integer', minimum: 0 },
        passed: { type: 'boolean' },
      },
      required: ['findings', 'errors', 'warnings', 'passed'],
    },
    permissionCallback: async (input: CheckPageInput | null, context) => {
      if (input?.id) return context.can('edit_post', input.id);
      return context.can('edit_posts');
    },
    executeCallback: async (input: CheckPageInput | null) => {
      if (!input || (input.content === undefined && input.id === undefined)) {
        throw new AbilityError(
          'ability_invalid_input',
          'Give the content or the ID of a page.',
          400,
        );
      }
      return runCheckPage(kernel, input);
    },
    meta: {
      annotations: { readonly: true, destructive: false, idempotent: true },
      showInRest: true,
    },
  });
}
