# Providers and credentials

Reviewer: platform and security. Phase 2. This file covers which model answers a request, and how the secret that reaches it is stored.

## Credentials are encrypted at rest

The human registers a provider at runtime. The program encrypts the secret with a master key and stores the ciphertext in SQLite.

The master key comes from configuration: an environment variable, with a config file path as the fallback. Algorithm is AES-256-GCM with a random 96-bit initialization vector per record. The record stores the initialization vector, the authentication tag and a key version. A key file must have mode 0600, and the daemon refuses to start otherwise.

Encryption at rest with a master key from configuration is the whole of the MVP scope. Key rotation is deferred.

This is separate from git authentication to remote origin, which is ambient on the daemon machine. See `../phase-1/git-foundation.md`.

## A registration is a named account

The human registers a provider at global scope through `pi-ai`. One registration holds a name, a provider type, a credential and a default model. The same provider type may be registered any number of times under different names, so three ChatGPT accounts are three registrations. The name is unique and is how every binding refers to it. At least one registration is mandatory to finish onboarding.

Registry operations are register, list, rename and remove. A removal is refused while a binding still names the registration, and the daemon lists the bindings that block it. Otherwise a removal would silently empty a chain and stop every node that resolves to it.

The MVP requires exactly one registration and one binding. The multi-registration rules below are the design the entity model already supports, and they are built after the MVP.

## The task attempt is the unit of selection

The daemon resolves the binding once, at the start of a task attempt, and pins one registration and one model for the whole attempt. A failure of that registration, of any kind, ends the attempt as a failure. The daemon never changes the registration or the model in the middle of an attempt, because a switch replays the context and repeats the work already paid for, which costs more than a clean retry. The attempt row records the pinned registration and model.

This rule holds in the MVP, with a list of one.

## Deferred: the ordered binding list

A provider binding resolves agent, then project, then global. Global always holds a list, because onboarding forces one registration. A project without a binding inherits the global list. An agent without a binding inherits the project list. An agent must end with a non-empty list, and the daemon refuses to run a node whose agent resolves to an empty list. A binding may name a model to override the registration default; otherwise the default model applies.

## Deferred: the chain advances across attempts

Attempt one uses the first registration in the resolved list. An attempt that fails on a provider error starts the next attempt on the next registration. The list wraps to the front after the last entry. The attempt limit still ends the task in `blocked`, so the chain never retries without bound. An attempt that fails on the verification command or on `re@1` keeps the same registration, because the provider worked.

## Deferred: key rotation

A CLI command that re-encrypts every record under a new key version.
