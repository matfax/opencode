<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/web/src/assets/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/web/src/assets/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/web/src/assets/logo-ornate-light.svg" alt="opencode logo">
    </picture>
  </a>
</p>
<p align="center">AI coding agent, built for the terminal.</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/sst/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/sst/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

[![opencode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### Purpose of this fork

This fork's purpose was to investigate different context management and retrieval techniques, including a file-specific natural language-first definition of code context, symbol and vector database storage and retrieval, and the use of multiple LLMs for different tasks, such as code application/integration, summary, and code generation, separate from the agentic supervised coding.
These techniques were supposed to improve the context size through strict structural enforcement of edit tasks with full file context, dynamic expansion of context through symbol and file content retrieval, and a final review pass to ensure code quality and correctness.
Unlike subagents defined in natural language, this approach is more strict, naturally enforces LSP protocols, and maintains the relevant context without overloading a primary or subagent model with parallel and crosscutting behavior like git context, documentation context, LSP context, and code quality enforcement.

The specific deficiencies of coding agents that this fork aims to address are:
* Misalignment of many models for diff edit formats
* Context overload through outdated or irrelevant information, paralleling multiple contexts (git, LSP, documentation, code quality) into a single agent
* Lack of strict structural enforcement of edit tasks, leading to incomplete or incorrect edits
* Disregard for the different strengths of different models for different tasks, leading to suboptimal performance
* Specific model behaviors that are not ideal for coding tasks, such as:
  * Assuming of context rather than investigating and retrieving context necessary for understanding the problem
  * Laziness about when a model decides completion of refactoring planning and implementation
  * Tendency to implement redundant/duplicate non-atomic code due to lack of awareness of potentially duplicate code sections that would be indicated in the same file, if completely read
  * Forgetfulness of earlier requirements, the tendency to implement features/requirements by discarding earlier ones, lacking the context of user motivation of code sections despite having comments explaining the behavior

The work on this fork was purely exploratory, and will be halted at this point due to architectural deficiencies:
* Schema-first off-repo upstream definition of SDK
* Lackluster type safety in TUI and poor understanding of golang best practices, requiring a complete refactoring of the TUI
* Parallel development of two different frontends (TUI and web) in two different languages, leading to divergence and lack of cohesion, though not necessary for the experiments
* Testing infrastructure that is only available upstream
