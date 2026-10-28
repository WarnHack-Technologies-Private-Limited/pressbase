import { escAttr, escUrl } from '@pressbase/blocks';
import type { HookBus } from '@pressbase/hooks';

/**
 * Scripts and stylesheets for public pages — WP_Dependencies, WP_Scripts and
 * WP_Styles (wordpress/wp-includes/class-wp-dependencies.php,
 * class-wp-scripts.php, class-wp-styles.php).
 *
 * A handle is registered once (source, dependencies, version, extra data)
 * and enqueued by name. Printing a queue resolves dependencies first
 * (all_deps()), prints every handle once, drops a handle whose dependencies
 * are missing, and remembers what was printed, so the head and the footer
 * never repeat an item.
 *
 * Differences from WordPress: no concatenation (load-scripts.php), no
 * translations, conditional comments, RTL stylesheets or fetchpriority, and
 * no `sourceURL` comments in inline code. Script tags use the markup of
 * wp_get_script_tag(); link and style tags keep WP_Styles' single quotes.
 */

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    script_loader_src: [src: string, handle: string];
    script_loader_tag: [tag: string, handle: string, src: string];
    style_loader_src: [href: string, handle: string];
    style_loader_tag: [tag: string, handle: string, href: string, media: string];
  }
}

export type Strategy = 'defer' | 'async';

/** The version appended as `?ver=`: undefined for the Pressbase version, null for none. */
export type Version = string | null | undefined;

export interface Dependency {
  handle: string;
  /** URL, or false for an alias (a handle that only groups its dependencies or carries inline code). */
  src: string | false;
  deps: string[];
  ver: Version;
  /** Scripts: 1 for the footer group. Styles: the media attribute. */
  args: number | string | undefined;
  extra: {
    /** Scripts: inline code before / after the tag. Styles: inline CSS (`after`). */
    before?: string[];
    after?: string[];
    /** wp_localize_script() output. */
    data?: string;
    strategy?: Strategy;
    group?: number;
    /** Styles: the title attribute. */
    title?: string;
  };
}

const STRATEGIES: readonly Strategy[] = ['defer', 'async'];

/** `</script` and `</style` would end the element early; `<!--` can confuse the parser. */
export function safeInline(code: string, element: 'script' | 'style'): string {
  if (element === 'style') return code.replace(/<\/(style)/gi, '<\\/$1');
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** A URL a page may load: http(s), protocol-relative or root-relative. Empty when unsafe. */
export function assetUrl(src: string, ver: string, extra = ''): string {
  let url = src.trim();
  if (!/^(?:https?:)?\/\//i.test(url) && !url.startsWith('/')) url = `/${url}`;
  if (ver || extra) {
    const hash = url.indexOf('#');
    const fragment = hash >= 0 ? url.slice(hash) : '';
    if (hash >= 0) url = url.slice(0, hash);
    if (ver) url += `${url.includes('?') ? '&' : '?'}ver=${encodeURIComponent(ver)}`;
    if (extra) url += `${url.includes('?') ? '&' : '?'}${extra}`;
    url += fragment;
  }
  return escUrl(url, ['http', 'https']);
}

/** WP_Dependencies */
export abstract class Dependencies {
  registered = new Map<string, Dependency>();
  queue: string[] = [];
  /** Handles enqueued before they were registered (enqueued when they are). */
  queuedBeforeRegister = new Map<string, string | undefined>();
  /** Query-string arguments from `handle?arg=1`. */
  args = new Map<string, string>();
  done = new Set<string>();
  groups = new Map<string, number>();
  protected toDo: string[] = [];

  constructor(
    protected readonly defaultVersion: string,
    protected readonly hooks?: HookBus,
  ) {}

  /** A copy for one page: registrations and queue are copied, nothing is printed yet. */
  clone(hooks?: HookBus): this {
    const Kind = this.constructor as new (defaultVersion: string, hooks?: HookBus) => this;
    const copy = new Kind(this.defaultVersion, hooks ?? this.hooks);
    Object.assign(copy, {
      registered: new Map(
        [...this.registered].map(([handle, dep]) => [
          handle,
          {
            ...dep,
            deps: [...dep.deps],
            extra: {
              ...dep.extra,
              before: dep.extra.before && [...dep.extra.before],
              after: dep.extra.after && [...dep.extra.after],
            },
          },
        ]),
      ),
      queue: [...this.queue],
      queuedBeforeRegister: new Map(this.queuedBeforeRegister),
      args: new Map(this.args),
    });
    return copy;
  }

  /** WP_Dependencies::add(): false if the handle already exists. */
  add(
    handle: string,
    src: string | false,
    deps: string[] = [],
    ver: Version = undefined,
    args?: number | string,
  ): boolean {
    if (!handle || this.registered.has(handle)) return false;
    this.registered.set(handle, { handle, src, deps: [...deps], ver, args, extra: {} });
    if (this.queuedBeforeRegister.has(handle)) {
      const arg = this.queuedBeforeRegister.get(handle);
      this.queuedBeforeRegister.delete(handle);
      this.enqueue(arg ? `${handle}?${arg}` : handle);
    }
    return true;
  }

  addData<K extends keyof Dependency['extra']>(
    handle: string,
    key: K,
    value: Dependency['extra'][K],
  ): boolean {
    const dep = this.registered.get(handle);
    if (!dep) return false;
    dep.extra[key] = value;
    return true;
  }

  getData<K extends keyof Dependency['extra']>(
    handle: string,
    key: K,
  ): Dependency['extra'][K] | undefined {
    return this.registered.get(handle)?.extra[key];
  }

  /** WP_Dependencies::remove() (wp_deregister_script()). */
  remove(handles: string | string[]): void {
    for (const handle of [handles].flat()) this.registered.delete(handle);
  }

  enqueue(handles: string | string[]): void {
    for (const raw of [handles].flat()) {
      const [handle = '', arg] = raw.split('?', 2);
      if (this.registered.has(handle)) {
        if (!this.queue.includes(handle)) this.queue.push(handle);
        if (arg) this.args.set(handle, arg);
      } else {
        this.queuedBeforeRegister.set(handle, arg);
      }
    }
  }

  dequeue(handles: string | string[]): void {
    for (const raw of [handles].flat()) {
      const handle = raw.split('?')[0] ?? '';
      const i = this.queue.indexOf(handle);
      if (i >= 0) {
        this.queue.splice(i, 1);
        this.args.delete(handle);
      } else this.queuedBeforeRegister.delete(handle);
    }
  }

  /** Every handle the queue needs, dependencies included (recurse_deps()). */
  protected allQueued(): Set<string> {
    const all = new Set<string>();
    const visit = (handle: string) => {
      if (all.has(handle)) return;
      all.add(handle);
      for (const dep of this.registered.get(handle)?.deps ?? []) visit(dep);
    };
    for (const handle of this.queue) visit(handle);
    return all;
  }

  /** WP_Dependencies::query() — wp_script_is() / wp_style_is(). */
  query(handle: string, status: 'registered' | 'enqueued' | 'to_do' | 'done' = 'registered') {
    switch (status) {
      case 'registered':
        return this.registered.has(handle);
      case 'enqueued':
        return this.allQueued().has(handle);
      case 'to_do':
        return this.toDo.includes(handle);
      case 'done':
        return this.done.has(handle);
    }
  }

  /** set_group(): an item moves to a lower group (the head) when something there needs it. */
  protected setGroup(handle: string, group: number | false): boolean {
    const g = group === false ? 0 : group;
    const current = this.groups.get(handle);
    if (current !== undefined && current <= g) return false;
    this.groups.set(handle, g);
    return true;
  }

  /** WP_Dependencies::all_deps(): builds the ordered to-do list, dependencies first. */
  allDeps(handles: string[], recursion = false, group: number | false = false): boolean {
    for (const raw of handles) {
      const [handle = '', arg] = raw.split('?', 2);
      if (this.done.has(handle)) continue;
      const queued = this.toDo.includes(handle);
      const moved = this.setGroup(handle, group);
      if (queued && !moved) continue;
      const item = this.registered.get(handle);
      const ok =
        item?.deps.every((d) => this.registered.has(d)) === true &&
        (item.deps.length === 0 || this.allDeps(item.deps, true, this.groups.get(handle) ?? 0));
      if (!ok) {
        if (recursion) return false;
        continue;
      }
      if (queued) continue;
      if (arg) this.args.set(handle, arg);
      this.toDo.push(handle);
    }
    return true;
  }

  /** WP_Dependencies::do_items(): prints the queue (or `handles`) for a group. */
  async doItems(handles: string[] | false = false, group: number | false = false): Promise<string> {
    this.toDo = [];
    // As in WordPress, groups come from each item (and what needs it), not from the pass.
    this.allDeps(handles === false ? this.queue : handles);
    const out: string[] = [];
    for (const handle of this.toDo) {
      if (this.done.has(handle) || !this.registered.has(handle)) continue;
      const html = await this.doItem(handle, group);
      if (html === false) continue;
      this.done.add(handle);
      if (html) out.push(html);
    }
    this.toDo = [];
    return out.join('\n');
  }

  /** Prints one item; false when it isn't printed now (a footer script in the head). */
  protected abstract doItem(handle: string, group: number | false): Promise<string | false>;

  protected version(dep: Dependency): string {
    if (dep.ver === null) return '';
    return dep.ver || this.defaultVersion;
  }
}

/** WP_Scripts */
export class Scripts extends Dependencies {
  protected override setGroup(handle: string, group: number | false): boolean {
    const dep = this.registered.get(handle);
    let calculated = dep?.args === 1 ? 1 : (dep?.extra.group ?? 0);
    if (group !== false && calculated > group) calculated = group;
    return super.setGroup(handle, calculated);
  }

  /** WP_Scripts::add_inline_script() */
  addInlineScript(handle: string, code: string, position: 'before' | 'after' = 'after'): boolean {
    if (!code) return false;
    const list = [...(this.getData(handle, position) ?? []), code];
    return this.addData(handle, position, list);
  }

  /**
   * WP_Scripts::localize(): `var objectName = {…};` before the script.
   * The name must be a JavaScript identifier; the data is JSON with `<`, `>`
   * and `&` escaped, so it can't close the script element.
   */
  localize(handle: string, objectName: string, data: Record<string, unknown>): boolean {
    if (!/^[A-Za-z_$][\w$]*$/.test(objectName)) {
      throw new Error(`"${objectName}" is not a valid JavaScript variable name.`);
    }
    if (!this.registered.has(handle)) return false;
    const json = JSON.stringify(data ?? {})
      .replace(/</g, '\\u003C')
      .replace(/>/g, '\\u003E')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const script = `var ${objectName} = ${json};`;
    const existing = this.getData(handle, 'data');
    return this.addData(handle, 'data', existing ? `${existing}\n${script}` : script);
  }

  /** WP_Scripts::add_data() refuses invalid strategies and strategies on aliases. */
  setStrategy(handle: string, strategy: Strategy | undefined): boolean {
    if (!strategy) return false;
    const dep = this.registered.get(handle);
    if (!dep || !STRATEGIES.includes(strategy) || !dep.src) return false;
    return this.addData(handle, 'strategy', strategy);
  }

  #dependents(handle: string): string[] {
    return [...this.registered.values()]
      .filter((d) => d.deps.includes(handle))
      .map((d) => d.handle);
  }

  /** filter_eligible_strategies() */
  #eligible(
    handle: string,
    eligible: Strategy[] | null,
    checked: Set<string>,
    queued: Set<string>,
  ): Strategy[] {
    let strategies = eligible ?? [...STRATEGIES];
    if (checked.has(handle)) return strategies;
    checked.add(handle);
    const dep = this.registered.get(handle);
    if (!dep || !queued.has(handle)) return strategies;
    const intended = dep.extra.strategy;
    if (dep.src && !intended) return [];
    if (dep.extra.after?.length) return [];
    if (intended === 'defer') strategies = ['defer'];
    for (const dependent of this.#dependents(handle)) {
      if (strategies.length === 0) return [];
      strategies = this.#eligible(dependent, strategies, checked, queued);
    }
    return strategies;
  }

  /** get_eligible_loading_strategy(): async only if nothing depends on it synchronously. */
  eligibleStrategy(handle: string): Strategy | '' {
    const intended = this.getData(handle, 'strategy');
    if (!intended) return '';
    const strategies = this.#eligible(
      handle,
      intended === 'defer' ? ['defer'] : null,
      new Set(),
      this.allQueued(),
    );
    if (strategies.length === 0) return '';
    return strategies.includes('async') ? 'async' : 'defer';
  }

  #inline(handle: string, position: 'before' | 'after'): string {
    const code = this.getData(handle, position);
    if (!code?.length) return '';
    return `<script id="${escAttr(handle)}-js-${position}">\n${safeInline(code.join('\n').trim(), 'script')}\n</script>`;
  }

  protected async doItem(handle: string, group: number | false): Promise<string | false> {
    const dep = this.registered.get(handle);
    if (!dep) return false;
    const itemGroup = this.groups.get(handle) ?? 0;
    // A footer script waits for the footer pass.
    if (group === 0 && itemGroup > 0) return false;
    const strategy = this.eligibleStrategy(handle);
    const intended = dep.extra.strategy ?? '';
    // A head script meant to be delayed but forced to block moves to the footer
    // when nothing in the head depends on it.
    if (
      group === 0 &&
      itemGroup === 0 &&
      intended &&
      !strategy &&
      this.#dependents(handle).every((d) => this.groups.get(d) !== 0)
    ) {
      return false;
    }
    const parts: string[] = [];
    const data = dep.extra.data;
    if (data) {
      parts.push(
        `<script id="${escAttr(handle)}-js-extra">\n${safeInline(data, 'script')}\n</script>`,
      );
    }
    const before = this.#inline(handle, 'before');
    const after = this.#inline(handle, 'after');
    if (!dep.src) return [...parts, before, after].filter(Boolean).join('\n');

    let src = assetUrl(dep.src, this.version(dep), this.args.get(handle));
    if (this.hooks) src = await this.hooks.applyFilters('script_loader_src', src, handle);
    if (!src) return parts.join('\n');
    const attrs = [`src="${escAttr(src)}"`, `id="${escAttr(handle)}-js"`];
    if (strategy) attrs.push(strategy);
    if (intended) attrs.push(`data-wp-strategy="${intended}"`);
    let tag = [before, `<script ${attrs.join(' ')}></script>`, after].filter(Boolean).join('\n');
    if (this.hooks) tag = await this.hooks.applyFilters('script_loader_tag', tag, handle, src);
    return [...parts, tag].filter(Boolean).join('\n');
  }

  /** wp_print_head_scripts() */
  doHeadItems(): Promise<string> {
    return this.doItems(false, 0);
  }

  /** wp_print_footer_scripts() */
  doFooterItems(): Promise<string> {
    return this.doItems(false, 1);
  }
}

/** WP_Styles */
export class Styles extends Dependencies {
  /** WP_Styles::add_inline_style() */
  addInlineStyle(handle: string, css: string): boolean {
    if (!css) return false;
    return this.addData(handle, 'after', [...(this.getData(handle, 'after') ?? []), css]);
  }

  protected async doItem(handle: string): Promise<string | false> {
    const dep = this.registered.get(handle);
    if (!dep) return false;
    const css = this.getData(handle, 'after');
    const inline = css?.length
      ? `<style id='${escAttr(handle)}-inline-css'>\n${safeInline(css.join('\n'), 'style')}\n</style>`
      : '';
    if (!dep.src) return inline;
    let href = assetUrl(dep.src, this.version(dep), this.args.get(handle));
    if (this.hooks) href = await this.hooks.applyFilters('style_loader_src', href, handle);
    if (!href) return inline;
    const media = typeof dep.args === 'string' && dep.args ? dep.args : 'all';
    const title = dep.extra.title ? ` title='${escAttr(dep.extra.title)}'` : '';
    let tag = `<link rel='stylesheet' id='${escAttr(handle)}-css'${title} href='${escAttr(href)}' media='${escAttr(media)}' />`;
    if (this.hooks)
      tag = await this.hooks.applyFilters('style_loader_tag', tag, handle, href, media);
    return [tag, inline].filter(Boolean).join('\n');
  }
}
