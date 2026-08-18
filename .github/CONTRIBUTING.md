# Contributing to Cortex Protocol

Thanks for your interest in contributing to Intelligence Rail.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/cortex-protocols`
3. Create a feature branch: `git checkout -b feat/your-feature`
4. Make your changes and commit using [Conventional Commits](https://www.conventionalcommits.org/)
5. Push and open a Pull Request

## Commit Convention

We use conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`

## Areas to Contribute

- Smart contract improvements (`contract/`)
- Backend API features (`backend/`)
- Frontend UI components (`frontend/`)
- Documentation and examples

## Versioning & Releases

The monorepo is versioned as a whole (frontend, backend, and contracts move
together) following [Semantic Versioning](https://semver.org). Every
user-facing change should add a bullet to the `[Unreleased]` section of
`CHANGELOG.md` in its PR.

To cut a release:

1. `bash scripts/release.sh <major|minor|patch|X.Y.Z>` — bumps every
   manifest and promotes the `[Unreleased]` changelog section
2. Review the diff, then commit: `git commit -am "chore(release): vX.Y.Z"`
3. `git tag vX.Y.Z && git push origin HEAD --tags`

Pushing the tag triggers the `Release` workflow, which validates the
changelog and manifests, then publishes a GitHub release with that
version's notes.
