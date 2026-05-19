# Contributing to MACH1 SDK

Thank you for your interest in contributing to the MACH1 SDK monorepo! This repository contains the core Monaco SDK, bot runtime, scripts, and test tooling.

## Table of Contents

- [Getting Started](#getting-started)
- [Repository Structure](#repository-structure)
- [Development Workflow](#development-workflow)
- [Code Quality](#code-quality)
- [Testing](#testing)
- [Reporting Bugs](#reporting-bugs)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Project Guidelines](#project-guidelines)
- [License](#license)

## Getting Started

1. Clone the repository:

   ```bash
   git clone https://github.com/<owner>/mach-one-sdk.git
   cd mach-one-sdk
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the workspace packages:

   ```bash
   npm --prefix packages/mach1_sdk run build
   npm --prefix packages/mach1_bot run build
   npm --prefix packages/mach1_bot run build:cli
   ```

4. Run package-specific commands from the package directory or with `npm --prefix`.

## Repository Structure

- `packages/mach1_sdk` — Monaco SDK client, APIs, protocol types, and shared utilities.
- `packages/mach1_bot` — trading bot framework, CLI, example bot configs, and strategy runtime.
- `packages/autosiege` — stress testing CLI for bulk order scenarios.
- `packages/modultest` — integration and smoke-test harness.
- `packages/backtest_scripts` — scripts used for backtest data management.
- `packages/standalone_scripts` — standalone utility scripts and examples.

## Development Workflow

- Create a branch for each feature, bug fix, or documentation improvement.
- Keep changes focused and easy to review.
- Use clear commit messages describing the intent and scope of the change.
- When working on a package, run package-specific build and test commands.

### Common Commands

- Install dependencies:
  ```bash
  npm install
  ```
- Build SDK:
  ```bash
  npm --prefix packages/mach1_sdk run build
  ```
- Build bot runtime:
  ```bash
  npm --prefix packages/mach1_bot run build
  ```
- Build bot CLI:
  ```bash
  npm --prefix packages/mach1_bot run build:cli
  ```
- Apply patches after install:
  ```bash
  npm install
  ```
  (The root `postinstall` runs `patch-package` automatically.)

## Code Quality

### Languages and Style

- This monorepo is primarily TypeScript.
- Follow existing code patterns in the package you are editing.
- Keep formatting consistent with surrounding files.
- Use clear, explicit variable and function names.

### Code Reviews

- Add a short description for the problem you are solving.
- Include relevant testing and verification steps in the PR description.
- Mark any work-in-progress clearly so reviewers know what remains.

## Testing

Where tests exist, run them before submitting changes.

### Example Test Commands

- Run package tests (if configured):
  ```bash
  npm --prefix packages/mach1_sdk test
  npm --prefix packages/mach1_bot test
  ```
- For package-specific tooling and builds, use the package `package.json` scripts.

If you add or modify behavior, include tests that verify the new behavior and prevent regressions.

## Reporting Bugs

When reporting an issue, please include:

- A short summary of the bug.
- Steps to reproduce.
- Expected behavior vs actual behavior.
- Relevant logs or error messages.
- Package or area of the repository affected.

## Submitting Pull Requests

- Open a PR against the `main` branch unless otherwise directed.
- Include a descriptive title and summary.
- Link any related issues or discussions.
- Describe how you validated the change locally.
- Keep PRs small and focused whenever possible.

## Project Guidelines

### Package Changes

- Prefer targeted package changes instead of broad repository-wide refactors.
- If you update one package API, verify dependent packages still build and run.
- Document any public API changes clearly in the associated package docs or README.

### Documentation

- Improve docs when needed.
- Keep examples accurate and aligned with the current codebase.
- Add or update README sections when introducing new package behavior.

### Security and Secrets

- Do not commit secrets, keys, or credentials.
- Use environment variables or local config files for sensitive values.

## License

By contributing, you agree that your contributions will be licensed under the same terms as the repository.
