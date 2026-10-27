# Hooks: actions and filters

`@pressbase/hooks` is the backbone of extensibility, as `WP_Hook` is in WordPress. The kernel owns one `HookBus`: `kernel.hooks`.

## The API

```ts
import { HookBus } from '@pressbase/hooks';
const hooks = new HookBus();

// Filters change a value and return it.
const off = hooks.addFilter('the_title', (title, postId) => title.trim(), 10);
const title = await hooks.applyFilters('the_title', rawTitle, 42);
off(); // remove this callback

// Actions run side effects.
hooks.addAction(
  'save_post',
  async (postId) => {
    /* … */
  },
  20,
);
await hooks.doAction('save_post', 42);
hooks.didAction('save_post'); // → 1
```

| WordPress                                           | Pressbase                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `add_filter($name, $cb, $priority)`                 | `hooks.addFilter(name, cb, priority = 10)`. Returns an unsubscribe function.                    |
| `apply_filters($name, $value, ...$args)`            | `await hooks.applyFilters(name, value, ...args)`                                                |
| —                                                   | `hooks.applyFiltersSync(...)`: throws if a callback is async                                    |
| `remove_filter`, `remove_all_filters`, `has_filter` | `removeFilter`, `removeAllFilters`, `hasFilter`                                                 |
| `add_action`, `do_action`, `did_action`             | `addAction`, `await doAction`, `didAction` (plus `doActionSync`)                                |
| `$accepted_args`                                    | Not needed; JavaScript ignores extra arguments.                                                 |
| `current_filter()`, `doing_filter()`                | Not provided: unreliable with concurrent async requests. Pass context in the arguments instead. |

## Semantics

- **Order:** ascending priority, then the order callbacks were added.
- **Async:** each callback is awaited before the next one runs.
- **Snapshot:** callbacks added or removed while a hook is running take effect from the next run.
- **Errors:** propagate to the caller. Core will isolate plugin failures when the plugin loader lands (v0.5).

## Typing hook names

Declare a hook's arguments once and every `addFilter` and `applyFilters` call is type-checked:

```ts
declare module '@pressbase/hooks' {
  interface FilterRegistry {
    the_title: [title: string, postId: number];
  }
  interface ActionRegistry {
    save_post: [postId: number];
  }
}
```

Undeclared names still work, with `unknown` arguments.

## Hooks core fires today

| Hook             | Type   | Arguments                  | Fired by                                           |
| ---------------- | ------ | -------------------------- | -------------------------------------------------- |
| `init`           | action | —                          | `Kernel.refreshState`, once the site becomes ready |
| `option_{name}`  | filter | `value, name`              | `Options.get`                                      |
| `updated_option` | action | `name, oldValue, newValue` | `Options.set`                                      |
| `deleted_option` | action | `name`                     | `Options.delete`                                   |
| `wp_login`       | action | `userId`                   | successful login                                   |

**When you add a hook to core,** use WordPress's name if WordPress has an equivalent. Add it to this table and declare its types.
