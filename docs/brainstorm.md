# Brainstorm

## Techstack

- Node@24, typescript@5
- SQlite: `node:sqlite`
- DAG:(graphology)[https://graphology.github.io/)
- Validation: zod@4
- Configuration: convict@6
- CLI: commander@15
- HTTP server: koa@3
- Git: simple-git@3.36.0

## Architecture

- We build services integrate with each others, and use command/query to perform business logic. Handle dependencies by using interface inject in service/command/query
  - Git: we build git service with simple-git@3.36.0 to setup common git behaviour in our program
  - Storage: use sqlite as driver, we build our storage interface need
  - DAG: common DAG behaviour
  - And more services
- CLI is for setup/administrator work
- HTTP server is program entrypoint, for any e2e test we need to spawn it up and invoke it by using either lib or cURL

## Ideas

We will have these entities in the system

- Global: allow other components inherit/binding them by default
  - Credentials
  - Git Repository
- Project: manage set of materials of work for a single feature (or similar with it concept)
  - [binding] Git repos: one project can involve multiple repositories: backend, frontend, mobile, devops, ...
  - [binding] LLM provider: powered by `@earendil-works/pi-ai`
- DAG: graph of works, initiative/objective/task (map from epic/story/task for general purpose). Core of execution management, store in SQLite, re-build when we need it
- Worker: pool of entity does the work: 1 -> unlimited
  - [binding] general@1: mostly invoke general@1 agent to do the work
  - [biding] tdd@1: run an agent loop to do the work based on TDD process (Red-Green-Refactor), invoke swe@1, te@1 and re@1 (optional)
- Agents: must be extendable with custom user instruction / project instruction / global instruction
  - general@1: do thing that cannot be clasified with general system instruction, custom version of `@earendil-works/pi-coding-agent`
  - swe@1: do code implementation, extend capacities based on different projecti, custom version of `@earendil-works/pi-coding-agent`
  - te@1: do test implementation, extend capacities based on different project, custom version of `@earendil-works/pi-coding-agent`
  - re@1: do code reviewing, including both test and code implementation, judge by using verification script or goals or acceptance criteria, custom version of `@earendil-works/pi-coding-agent`
  - mr@1: do local proposal, mostly is merge to main action, need human confirmation to merge
  - pr@1: sibling of mr@1, but propose a PR, watch until that PR become ready to merge, need human confirmation to merge
- Event-based: everything emit their event, store in SQLite

## How the product work

0. Human do the onboarding process to setup new project. Some custom behaviour can happen, for example: onboarding swe@1, te@1 and re@1 for NodeJS project is different with Go project
1. Human author initiative/objective/task DAG
2. Human import into KanthorD, make necessary modification
3. KanthorD's workers execute
4. Human watch the status, adjust the system to support KanthorD finishes the work

## Decisions

1. Git repository management: Bare-Home Isolated Clone Pattern, uses a bare repository as the single source-of-truth home (no working-tree drift risk) and clones it with --no-hardlinks and no origin remote for each working item, ensuring zero shared mutable state between workspaces and eliminating git worktree synchronization risks.
2. DAG: bind worker to project, overide by DAG binding, then override by node binding

## Open questions

1. How can we design the onboarding process that setup agent for two different kind of repository? For example backend in python and frontend for Vue and mobile for Flutter?
