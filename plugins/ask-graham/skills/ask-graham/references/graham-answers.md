# Graham's answers (verbatim provenance)

Graham is a frontend engineer and a friend of Jo Wolff, the author of this skill. Jo asked him seven questions on Discord on 2026-10-14 and relayed his answers the same day. He gave permission to be named and quoted (answer 7). The text below is his, unedited, including typos. `SKILL.md` cites these by number as "Graham #N".

## The questions Jo asked

1. When someone says "we should build X," what are the 3-5 questions you ask before saying yes?
2. What makes you say "no" or "not now"? Any instant dealbreakers?
3. One thing you'd kill or defer that most people would build, and why.
4. How do you weigh "it's cheap to build" against "it's not important right now"?
5. When two things both seem worth doing, how do you pick?
6. What should the answer look like? One line? Yes/no plus a why? A ranked list?
7. Are you OK with the skill being named after you and quoting your answers?

## Graham's answers

1. (Questions before yes) Why? How long lived? Something else already exists? My scope? Who owns it when its done or how will i maintain (depending on if corp. or personal work)?
2. (No / not now) Why should be more than "Its cool", personal productivity is fine, profitability is fine. "Rising Tide" is great.
3. (Would kill or defer) type systems, lol, but i'm ok with AI building it. Dont canonize platforms you dont control, if its a third party and they dont provide an enum, your enum is a lie. Ideally, use their enum. Never convert JSON to an object just to convert it back to JSON, use JSON libraries/native. Never build a string json by hand.
4. (Cheap vs not important) 2 minute rule from GTD: if we can do it in under 2 minutes, do it now. If not, its a task in the back log. If you want, you can prioritize it now.
5. (Picking between two) fewer lines of code? less complexity means less to maintain. Future functionality is often YAGNI
6. (Answer shape) Case by case. The bigger the task the larger breakdown. Its a fractal design, onion skin, where we have names like: High Level Design (HLD) -> Epics -> Stories -> Tasks|Acceptance critera. Tasks should be measured in hours or a few days at the most. With AI involved action items can be granular but WI should not describe untested codes a requirement: implementation is for the dev.
7. (OK to name it after him and quote him) 100%. Nothing would make me happier.

## Jo's override on answer 3

Jo's override: the skill does not question type systems.

Jo's words (2026-10-14): "graham and i disagree about type systems this skill should NOT be questioning use of a type system" and "...though if we are going to build our own that is stupid".

So the skill never counts using a type system, types, or typed code against an ask. Building a homegrown type system, typing layer, or schema layer where an established one exists is a red flag, and that red flag is Jo's, not Graham's.
