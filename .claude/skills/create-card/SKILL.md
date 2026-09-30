---
name: create-card
description: Turn a vague feature request, bug report, or improvement idea into an actionable Radulf backlog card. Interview the user, suggest concrete options, resolve scope and acceptance criteria, then create and verify the ticket in Radulf. Use for /create-card or requests to turn an idea into a backlog ticket, not requests to implement a change immediately.
---

# Create a Radulf backlog card

Turn the user's idea into one self-contained ticket that Radulf's planner,
implementation loop, and evaluator can execute without access to this chat.
Creating the card is the deliverable; leave it in **Backlog**.

## Ground the conversation

Treat the text accompanying `/create-card` (or `$create-card` in Codex) as the
starting brief. Reuse decisions already made in the conversation. If no idea
was supplied, ask what the user wants to change.

Read the repo's `AGENTS.md`, `CONTRIBUTING.md`, and `docs/ARCHITECTURE.md`, then
inspect the relevant code, tests, and current docs. Check
`docs/DESIGN_HISTORY.md` before treating a spec as current behavior. Investigate
facts the repo can answer instead of asking the user to locate files or design
the implementation for you. Keep this investigation proportional to the idea.

Use [the Radulf API guide](references/radulf-api.md) to identify the running
instance, registered repo, base branch, and potentially overlapping cards.
Default to this repository, matching its path rather than its display name.
Resolve a worktree back to its parent repository when matching. Ask only if the
target is missing or ambiguous. Surface likely duplicates with their links;
clarify whether the user wants a distinct follow-up before creating redundant
work. Do not silently modify an existing card.

## Interview until the work is clear

Be persistent and specific. Challenge vague terms such as "better", "fast",
"clean up", or "support X" with concrete scenarios. A short prompt is an
invitation to investigate and ask, not permission to invent the requirements.

- Ask one to three high-value questions per round, then wait for the answers.
  Use the host's question tool when available; otherwise ask in chat. Adapt
  follow-ups to what the user actually says rather than reading a questionnaire.
- Offer plausible options when useful. Recommend one and explain its tradeoff,
  grounded in the code or the user's goal. Make suggestions distinguishable
  from decisions; allow the user to choose a different approach.
- Start with the problem, who encounters it, and one concrete example of the
  desired result. Then resolve the smallest useful scope, boundaries, and how
  success will be observed. Explain why a question matters when it is not obvious.
- For bugs, establish reproduction steps, expected versus actual behavior, and
  the relevant environment. For features, walk through the entry point, main
  interaction, resulting state, and relevant empty/error cases. For performance
  work, establish the workload, measurement method, and target; do not invent a
  baseline or promise a speedup without evidence.
- Probe constraints that affect the result: compatibility, existing data,
  dependencies, UI behavior, and operational limits where relevant. Ask about
  product decisions; leave ordinary implementation choices to Radulf.
- If the idea spans unrelated outcomes, suggest a smaller first card and explain
  the split. Create additional cards only if the user agrees to the expanded
  count and scope; record dependencies by actual card ID where available.
- Briefly reflect settled decisions and remaining gaps after each round. Do not
  repeat answered questions or treat silence or a suggested default as agreement.

Stop interviewing when all of these are true:

1. The target repo and intended base branch are known.
2. The problem and desired behavior can be illustrated with a concrete example.
3. One coherent scope and its important exclusions are clear.
4. Acceptance criteria describe observable outcomes, including relevant failures
   and regressions, and there is a feasible way to verify them.
5. Constraints and dependencies are recorded, with no unresolved product choice
   that would force the planner to guess what the user wants.

Do not demand exhaustive answers to irrelevant questions. If the user explicitly
delegates a decision, choose a reasonable option and record it as an assumption.
When the missing information requires investigation, propose a bounded research
card with a concrete evidence/report deliverable instead of pretending an
implementation is specified. If the user stops or asks for a draft only, respect
that boundary and state what remains unresolved.

## Write the ticket

Use a concise, action-oriented title that names the behavior and affected area,
such as "Preserve board filters after opening a card". Avoid vague titles like
"Improve UX" and do not embed a fabricated ticket number.

Write the description in Markdown. Use the following structure, omitting sections
that add no information and replacing every instruction with concrete content:

```markdown
## Problem
Who is affected, what happens today, why it matters, and a concrete example.
For a bug, include reproduction steps and expected versus actual behavior.

## Desired behavior and scope
The agreed behavior, relevant states and edge cases, and what this card excludes.

## Acceptance criteria
- [ ] An observable outcome with a specific trigger and expected result.
- [ ] Relevant failure handling or existing behavior that must keep working.

## Constraints and dependencies
Agreed limits, compatibility needs, prerequisite cards, and delegated assumptions.

## Code context
Verified repo-relative paths, relevant existing behavior, and useful references.
Distinguish implementation suggestions from requirements and facts from hypotheses.

## Verification
Concrete checks or reproduction steps tied to the acceptance criteria.
Require `make check` for Radulf changes, plus any necessary manual checks.
```

Write for a fresh agent with no conversation history: include the decisions,
examples, and essential evidence rather than "as discussed" or chat-only links.
Use real repository paths and durable references. Do not include credentials.
The description is Radulf's planning input; put acceptance criteria there, not
in an invented API field. Radulf will generate its own plan and worktree later.

## Create and verify

Present the finished title and a brief scope summary, then submit the complete
ticket using [the API guide](references/radulf-api.md). Invoking this skill to
create a ticket authorizes that backlog insertion; do not add a redundant final
permission question once the requirements are settled. Honor any explicit
request to review the full draft before submission.

Verify the persisted card's ID, title, description, repo, base branch, and
`backlog` status. Report its title, link, and Backlog status. Do not move it to
Todo, start a run, create a GitHub issue, or implement the work as part of this
skill. If creation or verification fails, preserve the complete draft, explain
the actual blocker, and follow the guide's recovery rules rather than claiming
success or blindly posting a second card.
