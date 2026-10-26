---
title: Typed FIFO provenance is required before command-shaped prompts can act
status: building
workload: wl-mvh6d1orqmwg74
pr: 315
---

Issue: https://github.com/thewolff/jo-issues/issues/187

## Decision

A command-shaped prompt is not authority by itself. Before the surface applies a command, batch, pasted command block, or records a prose instruction row, it must take a matching typed submission from the existing FIFO. Only interactive and RPC input submissions supply this typed provenance. Text arriving only as a continuation, aside, extension-sourced input, or `omp -p` prompt does not count as Jo's typed submission and cannot apply commands or create a Jo instruction row.

A missing typed take applies nothing; this does not promise a visible notice. An ambiguous take warns and refuses rather than warning and applying. A single typed take and an unambiguously joined typed take retain their existing behavior; this does not replace the FIFO or introduce a new authentication mechanism. The existing FIFO behavior is described historically in `migration/items/typed-input-fifo.md`; that item predates this command-dispatch authority guard.

## Deployment

After the change is integrated, restart as2 so the running surface loads the new code. No data migration is required.

## Rollback

Revert this change on a new branch. Rollback restores the command-authority defect: untyped prompts could again reach command application. Preserve the mitigation by keeping answer lines out of automated replies while the defect is restored.
