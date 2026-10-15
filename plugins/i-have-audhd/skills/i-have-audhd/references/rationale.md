# Rationale

The reason and evidence behind each rule in [`../SKILL.md`](../SKILL.md), by section number. Full citations: [`sources.md`](sources.md).

No study covers how an agent should write to an AuDHD person during technical work. These rules extrapolate from adjacent evidence and were tested on one person. The conflicts between the ADHD and autism halves are documented; the resolutions are the author's and the part most likely to be wrong.

## Co-occurrence

Estimates of how many autistic people also have ADHD run from about 40 percent ([The Conversation](https://theconversation.com/what-is-audhd-5-important-things-to-know-when-someone-has-both-autism-and-adhd-233095)) to 50 to 70 percent ([Hours et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8918663/)), with individual studies ranging wider.

## Point of performance (the organizing principle)

Barkley: people with executive-function differences "will be best assisted by 'externalizing' those forms of information; the provision of physical representations of that information will be needed in the setting at the point of performance." Private, internal information is a weak source of behavioral control ([Barkley](https://www.russellbarkley.org/factsheets/ADHD_EF_and_SR.pdf)).

## 1. Skeleton

It externalizes the priority order instead of making the reader derive it. In the ICSE 2025 study of ADHD programmers, commenters reported that being put on the spot hurt their performance, and misaligned communication showed up in 22 of the posts studied ([Newman et al.](https://andrewbegel.com/papers/newman-icse25.pdf)).

Fixed format serves the autistic need for predictability; the content carries the ADHD need for novelty. "ADHD likes NEW, Autism likes the SAME" ([Autistic Girls Network](https://autisticgirlsnetwork.org/knowledge_base/audhd/), which calls this "a massive over-generalisation"); autistic people tend to "prefer things to stay the same," people with ADHD to "like spontaneity and novelty" ([The Conversation](https://theconversation.com/what-is-audhd-5-important-things-to-know-when-someone-has-both-autism-and-adhd-233095)).

## 2. Layer

The length conflict: ADHD pulls toward short because attention is expensive; autism pulls toward complete because ambiguity is expensive. Layering serves both in one message. That the traits conflict in one person is documented ([Vanderbilt Frist Center](https://www.vanderbilt.edu/autismandinnovation/audhd-the-hidden-dynamics-of-a-dual-diagnosis/)), as is autistic adults' preference for explicit, precise communication ([PMC12271282](https://pmc.ncbi.nlm.nih.gov/articles/PMC12271282/)).

## 3. Blunt facts, declarative requests

Autistic communication favors explicit, literal language and struggles with idiom and implication ([PMC12271282](https://pmc.ncbi.nlm.nih.gov/articles/PMC12271282/), [National Autistic Society](https://www.autism.org.uk/advice-and-guidance/about-autism/autism-and-communication)). ADHD demand avoidance means an external demand can stall someone who wants to meet it ([ADDA](https://add.org/demand-avoidance/)). Declarative language is one of the low-demand approaches used in pathological demand avoidance support ([Science Works Health](https://www.scienceworkshealth.com/post/demand-avoidance-in-adhd-overwhelm-vs-defiance-and-what-therapy-does-differently)). Splitting by sentence type gets both. The double empathy research frames this as a mismatch between differently wired partners, not a deficit ([arXiv 2602.02562](https://arxiv.org/html/2602.02562)).

Acknowledging in words applies the same preference for the literal: an emoji has no fixed meaning, and the reader takes the one they see, which may not be the one meant.

## 4. Recommend; at most two open decisions

Decision paralysis in ADHD tracks executive dysfunction, the same system that would narrow the options: in a study of 50 adults with ADHD it correlated strongly with executive-dysfunction scores, 58 percent hit it at least weekly and 35 percent daily ([PMC12438291](https://pmc.ncbi.nlm.nih.gov/articles/PMC12438291/)). Four balanced options hand the filtering work to the brain least able to do it. A recommendation can be rejected in one word; a survey has to be processed. The direction is well supported; the threshold of two is the author's.

Filler options: an option nobody would choose ("or leave the dead processes running and eating memory") costs a full read and a reply to reject something that was never live.

## 5. Grade every signal

From practice, not a study. An agent ended a message with a container showing `unhealthy`. It read as an alarm. The service was fine; the healthcheck was broken. An ungraded signal spends attention and gives nothing to decide with.

## 6. References survive without scrolling

A sentence pointing at information elsewhere has externalized nothing. Resumption slows with interruption length, and after longer gaps leans on rebuilding the task from what is visible ([PMC8247645](https://pmc.ncbi.nlm.nih.gov/articles/PMC8247645/)). One engineer with ADHD described needing "almost an hour" to reload a task's structure ([arXiv 2312.05029](https://arxiv.org/html/2312.05029v1)). The coined-phrase and plural back-reference checks exist because agents followed every other rule here and still failed this way.

## 7. Assumptions and intent

Naming the assumption makes ambiguity visible, which the autistic side needs, without spending a blocking turn, which the ADHD side cannot afford. The ICSE 2025 study: "I spent months constructing an elaborate test suite for one project after I thought I was given the request to do so, only to be told that it was entirely unnecessary" ([Newman et al.](https://andrewbegel.com/papers/newman-icse25.pdf)).

## 8. Resume by restating content

Resuming a session is structurally a standup: "daily standups can be hell because I have no idea what I was doing since the last standup" ([Newman et al.](https://andrewbegel.com/papers/newman-icse25.pdf)). 77 percent of programmers surveyed track task status with notes to rebuild context ([Parnin and Rugaber 2011](http://www.chrisparnin.me/pdf/parnin-sqj11.pdf)).

## 9. Durable means written

Things drop out of mind once they leave the visual field; "object permanence" is clinically a misnomer but describes the experience ([Simply Psychology](https://www.simplypsychology.org/object-permanence-and-adhd.html)). ADHD developers asked for "written recaps after 1 [on] 1s detailing action items, expectations, and deadlines"; 16 percent wanted additional notes or materials and 9 percent got them ([Newman et al.](https://andrewbegel.com/papers/newman-icse25.pdf)). An agent can grant it every session.

## 10. Commands handed to the user

A fenced code block is where every other rule quietly breaks: it does not look like a reference, so no check fires, and it still makes the user assemble state out of scrollback. The script file moves that state into the environment (Barkley's point of performance applied to the shell).

- The scratch directory sits outside every repository so cleanup tooling cannot delete the script's undo path.
- Asking the user to select the right span of terminal output and paste it back is assembling content out of scrollback, on the return path, at the moment they are most overloaded.

## 11. Machinery anchors

These three come from the plugin's Stop hook rather than from a study: they are the rules it can check (naming the artifact by a deterministic scan, the other two by a trigger plus a judge), kept as rules so each warning points at text. Each applies a rule above to a narrower case. Naming the artifact is rule 6 for work products; reporting what was not done is rule 9 for omissions, which otherwise leave no trace; bad news first is rule 1's needs-you ordering inside one message.

## Scope

Labeling which statements are verified facts and which are guesses is a separate concern, covered by a separate `output-types` skill.
