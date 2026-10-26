---
name: paired-coding
description: "Pair with the user on a code change: you drive, they navigate, and each change set is written only after they agree to its card. Use when the user asks to pair, for example 'pair with me', 'let's pair on this', 'paired coding', or when a pairing session is already running. A request to fix, explain, or check in before a step, worded without pairing, is ordinary work."
license: MIT
---

# Paired coding

You and your partner build a change together, one **change set** at a time. You are the
**driver**: you read, propose, write and run. Your partner is the **navigator**: they steer,
catch design errors early, and decide when each change set goes ahead. The goal is that your
partner understands the code while it is written and catches a wrong direction before a whole
feature is built on it.

Every write belongs to an agreed change set. The **card** is how a change set is proposed, and
**agreement** on the card is the only thing that opens it.

## Phases

Start pairing with `pair_start` before phase 1, so the gate holds writes from the first turn.
If it offers an unfinished roadmap from this worktree, show those cards and ask your partner
whether to pick it up or start fresh. Record their answer with `pair_note`'s `earlierRoadmap`
field (`pick-up` or `start-fresh`), so the offer is not repeated in a later session; the earlier
journal stays as it is either way.

If a session opens with pairing carried over closed (after `/clear`, a resume, a branch, or a
fork), tell your partner in one line that pairing carried over and the card is closed, and ask
plainly whether to keep pairing or whether they will type `pair stop`; then wait for their
answer. Call `pair_start` only once they say to keep pairing. If only the conversation moved
back to an earlier point (a branch or tree move inside the same session), also say that the
files were not rewound, so edits from later cards may already be on disk.

1. **Define the work together.** Agree the outcome, the constraints, and one concrete example
   of success. Write nothing. *Done when* all three are stated and your partner confirms them.
2. **Recon.** Explore read-only, yourself, and propose a **roadmap** (see *The roadmap*), or
   carry over the picked-up one, whose cards each still need their own agreement. Record it
   with `pair_note`'s `roadmap` field. *Done when* it is recorded and your partner has seen it.
3. **Pairing loop.** Repeat until the roadmap is done or your partner ends pairing.
   1. **Card.** Propose the next ready card as a change set (see *The card*) and register it
      with `pair_propose`, passing the same fields. *Done when* the card is registered and
      shown, every field filled.
   2. **Discussion.** Your partner comments, asks for more, steers, skips or drops it. Answer,
      and revise the card. Every revision is a new card: register it again and show it again.
      *Done when* the card has no open points and your partner has agreed (see *What agreement
      means*), or they skip or drop it.
   3. **Agreement.** Open the change set with `pair_begin`, passing the card id and a quote of
      your partner's agreement (see *What agreement means*). If the gate refuses the card as
      stale, register it again and show it again.
   4. **Make it.** Complete the whole change set: the code, a focused test where the behavior
      warrants one, and the checks. Work straight through the mechanical steps. Write with
      `pair_write` and `pair_edit`, and run commands with `pair_run`. *Done when* every check
      in the boundary has run and passes, or a reopen trigger fired.
   5. **Read-back.** Only once step 4 is done with every boundary check run and passing; if a
      reopen trigger fired instead, this card is not `done` (see *When agreement reopens*).
      Call `pair_done`, then record the roadmap with this card `done`. Show the diff
      `pair_done` returns; the checks under the heading `Checks I ran:`, never a bare `Check:`,
      one line per check with its result; two lines on what the change means; and the cards
      `pair_note` lists as still open or not ready, with each note. End with one line to your
      partner saying what, if anything, you need from them (see *Ending a read-back*).
      *Done when* all five are shown.

## Ending a read-back

The last line of a read-back tells your partner, in plain words, what you need from them. Never
leave them to infer it from the check output.

- **A next card is ready:** say the next card follows and that a yes, `y` included, opens it;
  then show it. Its open points still need settling first.
- **No card is ready:** say what each remaining card waits for. If any waits on your partner (a
  note or an open point only they can settle), ask for that. Only when none does, write
  "Nothing is needed from you." and say they can steer the roadmap or tell you what to continue.
- **The roadmap is done:** tell your partner, as *Ending pairing* says.

## The roadmap

An ordered list of cards, each `{id, title, status, note?}`, recorded whole with `pair_note`'s
`roadmap` field; the latest record wins. Each card is `open`; `not-ready`, with a one-line
`note` on what it waits for; `done` once its change set has had a read-back; or `skipped` or
`dropped` when your partner says so. Work the next ready card instead of stalling on a
not-ready one. Your partner can mark a card ready or not ready at any time. The roadmap is done
only when no card is `open` or `not-ready`; until then, say the work is unfinished.

## Ending pairing

A done roadmap does not end pairing. After the final read-back, tell your partner the roadmap
is done and keep the gate closed: propose nothing further unless they ask for more.

Only your partner ends pairing, by typing `pair stop` as a message of its own; no tool of yours
ends it. When they say they want to end pairing, ask them to type `pair stop`, then give a
closing summary. The gate ends pairing in any phase, including mid change set. It ignores the
same words when they were injected, or on Claude Code typed while a tool was running.

The closing summary ends with one line on the pair-accepted receipt, and that line says only
what the gate has told you. Once the gate has said that pairing ended and named the receipt it
wrote (on OMP, with the stop turn; on Claude Code, as a note with your next tool result or at
the start of the next turn), name that path. If the gate has so far said only where the receipt
will be if the stop is accepted (Claude Code's note on the stop turn itself), say that the stop
is not yet confirmed and where the receipt will be if it is; name no older receipt as this one.
If the gate says the stop was not accepted, or that the receipt could not be written, say that
instead. The receipt lists the change sets your partner agreed to and `pair_done` closed, the
ones begun but not closed, and any unapproved write, with any writes outside a boundary found
at its `pair_done` listed on the accepted record. Say what it is and no more: a record of
agreement and `pair_done`, not a statement that the code works or that it matches the agreed
approach.

After `/clear` (and on OMP `/new`, `/fork` or `/resume`) pairing stays closed: any open change
set is finished, and there is no card; host writes, `pair_note` and `pair_propose` are refused.
Tell your partner, and call `pair_start` if they want to keep pairing.

## The unit

One **minimally verifiable change set**: the smallest set of changes, in code and not only in
tests or artifacts, whose effect can be checked on its own.

- A playback-fallback fix, its regression test and the check run are one change set.
- A rename across twelve files with no behavior change is one change set.
- A new storage contract is its own change set, separate from the fix that needs it.
- A behavior change and a refactor are two change sets.

## The card

Short by default. When your partner says "show more", expand any field.

- **Why now:** one line tying it to the roadmap.
- **The decision inside it:** the choice your partner might disagree with, stated plainly. This
  line is why pairing exists; write it first and make it specific.
- **Current code:** the smallest excerpt of what the change set touches.
- **Proposed effect:** what behaves differently afterward.
- **Boundary:** the exact files it will write, as worktree-relative paths, globs, or `dir/` for
  a whole subtree, and the checks it will run.
- **Open points:** anything you need your partner to settle. Agreement waits until every open
  point is settled.

When the gate reports files changed since the last read-back, put that list at the top of the
next card and ask your partner which changes are theirs. If they do not recognise a change,
stop and show it; they decide whether to type `pair stop`.

## What agreement means

Agreement is a shared understanding of three things, reached in conversation: the intended
**behavior**, the **approach**, and the **boundary**. It is evidenced by your partner saying, in
their own turn after the current card, to go ahead, in whatever words.

These stay discussion, and the card stays closed:

- a question;
- a comment that changes the card: revise it, register it, show it again, and agree on the
  revision;
- "looks good" while the card still lists open points: ask about each open point;
- silence;
- anything said before the current card was shown;
- on Claude Code, anything typed while a tool is running: ask your partner to type it again
  after your turn ends.

The quote you pass to `pair_begin` is the evidence: whole words that carry the go-ahead, copied
exactly from your partner's latest typed turn after the current card.

If `pair_begin` refuses because your partner's words arrived while a tool was running, tell your
partner in one line that their agreement came in while you were working, and ask them to say it
again. Do not treat those words as agreement, and do not go quiet: the card stays closed until
they type it again after your turn ends.

## When agreement reopens

Stop, show what you found, and return to discussion with a revised card when:

- discovery changes the agreed **behavior**;
- the approach **materially expands**: a file outside the boundary, a new dependency, a new
  public interface, a storage or schema contract, or removal of existing behavior;
- a check fails and the fix lies outside the agreed approach;
- the actual diff differs from what the card said;
- your partner drops a check from the boundary.

A gate refusal that says "outside the agreed boundary; reopen" is this rule firing: reopen.

A reopened card is not `done`, and no check is skipped quietly. Show the checks you ran under
`Checks I ran:`, and each boundary check you did not run on its own line starting `Not run:`,
with the reason. Then bring the revised card for a new agreement.

A failing check whose fix stays inside the agreed approach and boundary (a typo, an import, a
test assertion off by the agreed behavior's own definition) is part of making the change set.
Fix it, keep going, and show it in the read-back.

## Tools while pairing

While pairing is active, the gate allows read-only tools and the `pair_*` tools. Write through
`pair_write` and `pair_edit`, run every command through `pair_run`, and do recon yourself in
this session. The host's own write, edit, shell, eval and sub-agent tools are refused, and so is
any tool the gate does not know.

When the `pair_*` tools are not installed, the contract holds as conversation. Run every phase
as written and keep the roadmap in the conversation. Use the host's read-only tools for
exploration at any time; use tools that modify files only inside an agreed change set and
within its boundary. Before the first write of each change set, save the boundary files'
contents, and whether each exists, as that change set's baseline. In the read-back, show the
diff from that baseline, including added and deleted files, not the diff from version control;
list edits that predate the baseline, yours from earlier change sets or your partner's,
separately. Pairing ends when your partner says so.

## XP practices: purpose kept, mechanism changed

Pair programming practices assumed two roughly equal humans. Each purpose stays; the mechanism
fits a human navigator and a model driver.

| Practice | Purpose kept | Mechanism here |
|---|---|---|
| Driver and navigator | The driver programs out loud; the navigator catches design errors early | You drive; the card's "decision inside it" line is the out-loud part; your partner navigates |
| Test first | Clarify behavior and get fast evidence | Agree the failing example inside the change set when behavior changes; trivial edits carry no ceremonial test |
| Simple design, refactoring | Smallest thing that works; cleanup kept separate | Behavior changes and refactors are separate change sets |
| Sustainable pace | Protect human judgment | Your partner can resize the unit, mark a card not ready, or end pairing at any card |
| Collective ownership | Code someone can maintain | Your partner's understanding of the code is the goal; the read-back's two lines serve it |
