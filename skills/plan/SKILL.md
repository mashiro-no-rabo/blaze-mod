---
name: plan
description: Research the code base and make a plan for a new change, using the blaze system to organize.
allowed-tools: Write(.blaze/**), Edit(.blaze/**)
---

Research the code base and generate a plan file, save the file in `$(jj workspace root)/.blaze/$(jj log -GT 'change_id')/plans/`, by default use `PLAN.md`, if it already exist then summarize the content for a new title.
