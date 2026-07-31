 
Examples include:
 
* architecture
* APIs
* coding standards
* deployment
* security
* operations
* ADRs
 
It answers:
 
> How does the software work?
 
`.ai/` is documentation for AI contributors.
 
It should contain:
 
* reusable prompts
* implementation workflows
* agent standards
* contributor guidance
 
It answers:
 
> How should an AI agent work in this repository?
 
`.ai/` should reference `docs/` rather than duplicate it.
 
---
 
### AGENTS.md
 
Create or update `AGENTS.md`.
 
Keep it concise.
 
It should:
 
* describe repository conventions
* direct agents to the appropriate documentation
* explain where temporary work belongs
* explain how permanent knowledge should be documented
* explain multi-agent collaboration
 
Avoid placing detailed project documentation inside `AGENTS.md`.
 
Use it as an entry point into the repository.
 
---
 
### Multi-Agent Collaboration
 
Document that:
 
* each agent should use its own directory beneath `.work`
* temporary files should never become dependencies
* permanent knowledge belongs in committed documentation
* implementation notes belong in temporary workspaces
* reusable prompts belong in `.ai/prompts`
* reusable workflows belong in `.ai/workflows`
 
---
 
### Documentation Philosophy
 
Document the following principle:
 
> If future developers or future AI agents will benefit from the information, commit it.
 
> If the information is only useful while solving the current task, place it in the temporary workspace.
 
---
 
### Quality Checks
 
Before finishing, verify:
 
* repository structure exists
* ignored directories are ignored
* documentation clearly distinguishes `docs` from `.ai`
* AGENTS.md is concise
* no temporary directories are referenced as project dependencies
* no existing project behavior changed
 
Finally, summarize every change you made.