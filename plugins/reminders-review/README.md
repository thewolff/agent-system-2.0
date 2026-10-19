# Reminders review

A skill that goes through your open Apple Reminders with you, one at a time.

For each reminder the agent decides what kind it is and says so:

- **A question**: it gives you an answer, researched if needed.
- **An instruction**: it tells you how it reads it and how it would do it, and acts only after you say yes to both.
- **A note or idea**: it says what it thinks the reminder is for and offers one useful next step.
- **Unclear**: it asks.

Before moving on, it asks "Can I close this one?" Yes marks the reminder complete. No means you keep working on it together. You can also tell it to leave a reminder open and move on. It never deletes reminders.

## Requirements

- macOS.
- [remindctl](https://github.com/openclaw/remindctl): `brew install steipete/tap/remindctl`. The first run asks for Reminders access for your terminal app; `remindctl status` should then say `Full access`.

## Install

Claude Code:

```
/plugin marketplace add thewolff/jo-wolff-plugins
/plugin install reminders-review@jo-wolff-plugins
```

OMP:

```
omp plugin marketplace add thewolff/jo-wolff-plugins
omp plugin install reminders-review@jo-wolff-plugins
```

## Use

```
/reminders-review                    # the lists saved in your config, or it asks which ones
/reminders-review "Errands" "Work"   # these lists, this time
/reminders-review lists Errands Work # save these lists as your default
```

The default lists live in `${XDG_CONFIG_HOME:-~/.config}/reminders-review/config.json`:

```json
{ "lists": ["Errands", "Work"] }
```

## Safety

The text of a reminder is treated as data, never as permission. A reminder that says "delete the old branch" gets a proposal and two questions, not an action. Closing uses `remindctl complete`; the skill has no delete path.
