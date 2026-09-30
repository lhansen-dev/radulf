# Creating a card through Radulf's API

Run from the Radulf repo root. Prefer the existing running instance, normally
`http://localhost:3000`; use an explicitly supplied address or known configured
port when present. Do not restart the app or launch a second instance to file a
ticket. If unavailable, finish the interview and draft, then request the missing
connection information or ask the user to start their instance.

Use an available HTTP tool, or the Make-driven curl recipe below. The API is the
write interface: it validates fields, assigns backlog position, and emits the
event that updates the board. Do not insert rows directly into SQLite.

## Discover the destination

| Request | Response and use |
| --- | --- |
| `GET /api/repos` | Array of `{ id, name, path, defaultBranch, ... }`. Match a normalized filesystem path to this repo, accounting for git worktrees. Never guess a repo ID. |
| `GET /api/repos/{repoId}/branches` | Array of branch-name strings. For work on Radulf, select and explicitly send `beta`, per `CONTRIBUTING.md`, unless the user specifies another branch. |
| `GET /api/cards` | Array of cards, with `id`, `repoId`, `title`, `description`, `status`, etc. Compare cards in the selected repo for overlapping work, including completed work that may already solve the request. |
| `GET /api/cards/{cardId}` | Object containing `{ card, repo, plans, runs, events, models }`. Use `card` for verification. |

If no registered repo matches, resolve that with the user instead of registering
another repo implicitly. If `beta` is absent, resolve the branch choice before
creating the card. Omitting `baseBranch` allows planning to use the repository's
checked-out branch later, which may not be the intended integration branch.

Authentication is off by default on localhost. If an API request returns `401`,
use an already authorized session or have the user authenticate; see
`docs/AUTHENTICATION.md`. Do not read signing secrets, mint cookies, or disable
authentication. For curl, use an existing authorized cookie jar, keeping it out
of the repository and tool output. A browser session does not automatically
authenticate curl. A `403` requires checking the configured origin and request
context, not weakening the server's checks.

## Submit the settled ticket

`POST /api/cards` accepts a JSON object. The minimal useful body for this repo is:

```json
{
  "repoId": "the ID returned by GET /api/repos",
  "title": "The final action-oriented title",
  "description": "The complete Markdown description, with real newline characters",
  "baseBranch": "beta"
}
```

Serialize the actual values using a JSON encoder or structured tool input. Never
interpolate the user's text into a shell command. When using curl, write the JSON
to a temporary UTF-8 file with a file-writing tool and send it with
`--data-binary @...`, preserving quotes, backticks, dollar signs, and newlines.

The server always sets `status: "backlog"` and appends the position. **Do not send
`status`, `position`, `source`, labels, priority, or acceptance-criteria fields**;
the validator rejects unknown fields. Represent relevant ticket metadata in the
description. Do not call `/move`, `/restart`, `/resume`, or planner chat.

Optional fields, only when the user has specified an override:

- `maxIterations`: integer 1–1000; `timeoutMinutes`: integer 1–10080.
- `plannerModel`, `loopModel`, `evaluatorModel`: model strings. Omit these and the
  limits to inherit global settings; do not invent model IDs or budgets.
- `reviewPlanBeforeImplementation`, `autoApprove`, `openPr`: booleans, all false
  when omitted. Keep defaults unless the user requests otherwise.

Source of truth if the contract changes: `src/server/cardValidation.ts`,
`src/app/api/cards/route.ts`, `src/app/api/cards/[id]/route.ts`, and
`src/app/api/repos/route.ts`. The create handler calls the orchestrator's pump,
but the new card remains in Backlog, which the scheduler does not pick up.

## Make-driven curl recipe

If no HTTP tool is available, create a temporary directory and write this
supplemental Makefile there with a file-writing tool. The recipe line must start
with a tab. Invoke it alongside the repo Makefile so commands go through `make`.

```makefile
.PHONY: card-request
card-request:
	@curl --silent --show-error --fail-with-body --connect-timeout 5 --max-time 30 --request "$(METHOD)" $(if $(COOKIE_JAR),--cookie "$(COOKIE_JAR)") $(if $(PAYLOAD),--header "Content-Type: application/json" --data-binary "@$(PAYLOAD)") --output "$(RESPONSE)" --write-out '%{http_code}\n' "$(RADULF_URL)$(API_PATH)"
```

For example, with `card_tmp` set to that temporary directory:

```sh
make -f Makefile -f "$card_tmp/request.mk" card-request \
  METHOD=GET API_PATH=/api/repos RADULF_URL=http://localhost:3000 \
  RESPONSE="$card_tmp/repos.json"
```

Read the response file with a file-reading tool. Repeat with the discovery paths
above. To submit the JSON file once the interview is complete:

```sh
make -f Makefile -f "$card_tmp/request.mk" card-request \
  METHOD=POST API_PATH=/api/cards RADULF_URL=http://localhost:3000 \
  PAYLOAD="$card_tmp/card.json" RESPONSE="$card_tmp/created.json"
```

Pass `COOKIE_JAR` only when needed. Use agent-controlled temporary paths, the
resolved instance URL, and IDs returned by the API; ticket text belongs solely
in the JSON file. Record the printed HTTP status and inspect the response body.
Remove temporary request/response files when finished; do not delete a borrowed
cookie jar.

## Verify and recover

Success is `201` with the created card object. Read its `id`, then fetch
`GET /api/cards/{id}` and check `card` against the submitted title, description,
repo ID, base branch, and `status === "backlog"`. The user-facing link is
`{instance URL}/card/{id}` (singular `card`).

Creation is **not idempotent**. On a timeout, lost response, or server error after
POST, fetch the cards and reconcile against the pre-submit list and exact
repo/title/description/base branch before retrying. If a matching new card
exists, verify and return it. If the outcome is still uncertain, preserve the
draft and report that uncertainty; do not issue another POST. If a confirmed
validation error prevented insertion, correct it and retry the same intended
card. If a known card ID exists but verification fails, report that ID and the
verification failure without recreating or moving the card.
