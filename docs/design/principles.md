# Design principles

These principles settle design debates. When two good ideas conflict, the one higher on this list wins.

## 1. Familiar before novel

Forty percent of the web has learned WordPress's admin. Pressbase keeps its information architecture and vocabulary (Posts, Pages, Media, Comments, Appearance, Plugins, Users, Tools, Settings, in that order) and its mental models (a status, a role, a slug). We change the _interaction_ where we can make it clearly better, never the _map_.

> Test: could a WordPress user find it in under five seconds without reading anything?

## 2. One clear next step

Every screen has at most one primary button. Secondary actions are quieter (secondary or ghost buttons). Destructive actions are separate from the primary action and use the danger style.

> The installer's database step has one button, _Connect and continue_, which tests the connection as part of continuing.

## 3. Calm by default

The admin is a workplace. There are no nag banners, no upsells, and no notice stacks above the page. Notices show up in context (next to what they're about), say what to do, and go away once dealt with. Colour carries meaning. It isn't decoration.

## 4. Show the state honestly

- Unbuilt features say when they're coming ("Posts is on the way · v0.2") instead of linking to dead ends.
- A loading button keeps its label and adds a spinner ("Installing…").
- Unsaved changes are always visible (the save bar) and protected (a warning before leaving the page).
- Risky configurations, such as the built-in database or search engines discouraged, stay visible on the dashboard until they're fixed.

## 5. Errors are help, not blame

Every error says **what happened** and **what to do next**, in plain words, next to where the problem is. Focus moves to it. See [Voice and tone](voice-and-tone.md).

## 6. Accessible is the baseline

WCAG 2.2 AA on every screen, keyboard-first, with screen readers in mind. A feature isn't done until it passes the [accessibility checklist](accessibility.md).

## 7. Content first, chrome last

Admin chrome (sidebar, top bar) uses neutral surfaces and small type, so the user's content and data stand out. Pages have a 1080px maximum width, keeping line lengths readable.

## 8. Systematic, not bespoke

Every colour, size and duration comes from a [token](tokens.md). Every control comes from the [component kit](components.md). A one-off style needs a reason; usually it means the system needs a new token or component, so add that instead.
