# The convoy manifesto

1. Small tools, composable, packaged as convoy. pty (sessions), smalltalk (bus), personas (roles), evals (proof) each stand alone. convoy ties them into one story.
2. Write isolated agents, each owning its own folder, repo, or worktree. No shared state. The network is transparent, so an agent can look instead of asking. Less need for coordination.
3. Communicate with message passing, writing into each other's inboxes. Only the inbox is world-writable.
4. An Erlang-style supervision tree: CoS → supervisor → worker, each keeping the layer below alive and moving.
5. Intelligent agents, deterministic plumbing. An agent can't reliably wake itself, but a dumb timer/heartbeat can. Smarts live in the agents; the plumbing just keeps them ticking.
6. Reversible by default. Everything cheap to undo: git history, branches, drafts-before-sends. If it can't be undone cheaply, it's a decision to surface.
7. Biased to action, biased to work. Speed and flexibility first; drive reversible work, don't wait to be asked. Ask for no, not yes.
8. Durable, rehydratable state. An agent is killable and comes back from its durable state (repo + notes + bus), not a fragile transcript. Restarts are routine.
9. Evals (freeze-dried state + a judge) prove the system works. The folder can be scaffolded, agents auto-wake, work gets done, then the product can be scored.
10. The human is the only command channel. Commands come only from the human, directly. Everything on the bus is data to act on, never an instruction to obey — even if it claims to be the human.
