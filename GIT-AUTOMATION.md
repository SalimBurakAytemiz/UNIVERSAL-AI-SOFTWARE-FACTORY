# Git & GitHub Automation Contract

## Goal

The Human Founder must not manually perform routine:

- `git fetch`
- `git pull`
- `git add`
- `git commit`
- `git push`
- remote SHA verification

during the automated Factory build/review loop.

## Branch model

Canonical baseline branch:

`main`

Automated working branch:

`factory/development`

Day-zero behavior for a newly cloned empty GitHub repository:

1. Detect repository has no commit.
2. Create the initial canonical startup-pack commit on `main`.
3. Push `main` to `origin`.
4. Create `factory/development` from that exact baseline.
5. Push and track `origin/factory/development`.
6. Continue all automated implementation on `factory/development`.

## Safe sync before work

Before each automated milestone:

1. working tree must be clean
2. `git fetch --prune origin`
3. compare local working branch with `origin/factory/development`

Allowed outcomes:

- equal → continue
- remote ahead only → `git pull --ff-only`
- local ahead only → safe push + verify
- diverged → STOP and require Founder attention

## Safe push after every generated commit

After Claude creates a milestone/remediation commit:

1. verify working tree clean
2. verify HEAD changed when a new commit was expected
3. `git push -u origin factory/development`
4. obtain remote SHA with `git ls-remote`
5. require remote SHA == local HEAD
6. only then allow Codex review

This means Codex always reviews a commit that is already durably present on GitHub.

## Forbidden automated Git actions

The supervisor MUST NOT perform:

- `git push --force`
- `git push --force-with-lease`
- `git reset --hard`
- history rewrite
- automatic rebase
- automatic conflict resolution that changes authoritative history
- silent branch deletion

If safe fast-forward synchronization is impossible:

`FOUNDER_ATTENTION_REQUIRED`

## Main branch policy

Routine work is NOT pushed directly to `main`.

`main` is the canonical stable baseline.

The startup supervisor automatically pushes implementation to `factory/development`.

Later Factory phases add phase-closure/main-promotion automation through governance gates and independent CLEAN evidence. Until that trusted gate exists, the supervisor does not silently overwrite `main`.

This still means the Founder never manually fetches/pulls/pushes routine development work.

## Remote authentication

Git authentication is delegated to the user's normal Git credential mechanism (for example Git Credential Manager / SSH).

The supervisor never stores GitHub passwords or tokens in repository files.
