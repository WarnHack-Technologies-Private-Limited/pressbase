# Voice and tone

Pressbase sounds like a capable colleague: calm, clear and on your side.

## Principles

1. **Plain words.** "Couldn't connect to the database," not "Database connection exception (ECONNREFUSED)." Technical detail goes in a hint or a log, not the headline.
2. **Say what to do next.** Every error answers "now what?" _"The database server refused the connection. Check that PostgreSQL is running and that the host and port are right."_
3. **Don't blame.** "That setup code is not right," not "You entered an invalid code."
4. **Be brief.** Cut every word that doesn't help. Helper text is one sentence.
5. **Be honest.** Say when something isn't built yet, what a choice trades off ("Not meant for live sites"), and when something is risky.

## Mechanics

- **Sentence case** everywhere: "Save changes", "Site health". Product names keep their capitals.
- **Buttons are verbs** that name the result: "Install Pressbase", "Connect and continue", "Log in". Avoid "OK", "Submit" and "Yes".
- **Loading labels** use the "-ing" form with an ellipsis: "Installing…".
- **Contractions are fine** ("you'll", "can't"). Use curly apostrophes in UI copy: ’.
- **Address the user as "you"** and Pressbase as "Pressbase" (or "we" in docs). Avoid "my" in UI labels.
- **Numbers:** numerals ("5 attempts"), localized with `toLocaleString`.
- **Dates:** follow the site's `date_format` and `time_format` options.

## Words we use

| Use                                    | Avoid                                 |
| -------------------------------------- | ------------------------------------- |
| Log in / Log out (verbs), login (noun) | Sign on, logon                        |
| Site                                   | Blog, instance                        |
| Built-in database                      | PGlite, embedded DB (in the UI)       |
| Delete                                 | Remove (when it's permanent), Destroy |
| Settings                               | Preferences, Options (in the UI)      |
