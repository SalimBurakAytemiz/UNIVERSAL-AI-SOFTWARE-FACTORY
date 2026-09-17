# Startup Pack Version

Canonical startup package:

`v4-FULL-AUTO-GIT`

This package supersedes all earlier UASF startup ZIPs.

Key addition:
- Day-zero Claude → Codex → Claude automation
- automatic safe Git fetch / ff-only sync / commit verification / push / remote SHA verification
- automatic development branch creation
- automatic first baseline push to `main`
- no force-push / hard-reset / rebase automation
- automatic stop on local/remote divergence
