# 21: Registering a repository by URL

Decided 2026-09-22. Extends locked decision 1 in
[00-overview.md](00-overview.md#locked-decisions) without reversing it: a card
still targets a registered local git repository. What changes is how a
repository becomes local.

## The problem

Registration assumed the checkout already existed on the machine running
Radulf. `POST /api/repos` takes a path, and `POST /api/repos/init` creates a
fresh repository inside the browsable root. Both are right for a laptop, where
the repositories are the user's own working copies.

On a server they are wrong. Nothing is checked out there, and in the container
image added the same day the only way to make a repository visible was a bind
mount prepared before the container started, with a restart to add another.
The question that prompted this spec was whether repositories could be added
while the server runs, from the app, the way everything else is.

## Alternatives rejected

- **Mounting host directories into the running container.** Docker cannot add
  a bind mount to a running container. Doing it by recreating the container
  needs the Docker socket, which [SECURITY.md](../SECURITY.md) and spec 14
  treat as root-equivalent and keep out of reach on purpose.
- **Browsing the container's filesystem.** There is nothing to browse; the
  folder picker lands in an empty home directory.
- **A configurable clones directory.** `RADULF_WORKTREES_DIR` and
  `RADULF_PLANS_DIR` exist, but nobody has asked to move clones, and the
  container's compose file already uses `RADULF_REPOS_DIR` for the host bind
  mount. A third path variable with a near-identical name invites the wrong
  one being set.

## The decision

**`POST /api/repos/clone` takes a URL and Radulf clones it.** The clone lands
in `<data-parent>/repos/<name>`, a sibling of `data/` exactly like
`worktrees/` and `plans/`, and is then registered through the same
`registerRepo` path as an existing checkout. In the container that directory is
inside the state volume, so no mount is involved. The folder browser gains a
**Clone from URL** row beside **Create here**, in both places it appears.

- **Name.** The last path segment of the URL less `.git`, unless the request
  names it. Either way the name passes the same rule as `init`: a plain folder
  name, no separators, not hidden, nothing git or a shell would read as an
  option. A second URL that ends in the same segment has to be given a name.
- **Transports.** `https://`, `http://`, `ssh://`, scp-style `git@host:`, and
  `file://`. A bare path is not accepted: registering a checkout that already
  exists on the machine is `POST /api/repos`, and letting the clone endpoint
  take paths would give it two jobs. `ext::` is a command, not a URL, and git
  refuses it by default anyway.
- **Credentials.** The operator's own, host-side, exactly as spec 15's push:
  `GIT_TERMINAL_PROMPT=0` and SSH `BatchMode` so a missing credential fails
  in seconds instead of hanging on a prompt. In the container that means
  `gh auth login` followed by `gh auth setup-git`, or an SSH key in the
  persisted home. The clone shares spec 15's ten-minute remote bound.
- **Sandbox.** The clones directory joins `$HOME`, `data/` and `worktrees/`
  in the L1 read deny and in the roots `dropRootsThatWouldReopen` protects.
  A run's own shared `.git` is re-allowed through `gitCommonDir` as before.
  This is the posture a laptop already has, where repositories live under
  `$HOME`; a server install gets it for its clones instead of leaving every
  clone readable to every run.
- **Empty remotes.** A remote with no commits clones successfully and is
  still unusable, so the same check `POST /api/repos` applies runs after the
  clone and the folder is removed on failure. Likewise on a failed clone.
- **Default branch.** Whatever the remote's `HEAD` points at, which is what
  the clone checked out. Falls back to the checked-out branch, then `main`,
  matching `POST /api/repos`.
- **Pull requests.** A clone always has `origin`, so spec 15's delivery is
  available for it with no further configuration.

## Accepted residuals

- **Anyone who can reach the UI can make the server clone a URL** with the
  server's credentials and network. That is the same trust `POST /api/repos`
  and `POST /api/repos/init` already extend, and the password gate in
  [AUTHENTICATION.md](../docs/AUTHENTICATION.md) is what stands between the
  internet and all three.
- **No fetch after the clone.** Radulf works on the clone's base branch as
  cloned. Keeping it current with the remote is the operator's job, or spec
  15's pull-request flow in reverse. A "sync from remote" action is its own
  decision.
- **Full clones only.** A large repository takes as long as `git clone`
  takes. Shallow or partial clones would need a story for every git command
  a run might issue, and nobody has hit the limit.
