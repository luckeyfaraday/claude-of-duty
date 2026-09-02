# Contributing to Claude of Duty

Thanks for helping improve the project. By participating, you agree to follow
the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening a change

- Search existing issues and pull requests first.
- Open an issue before a large feature or architectural change.
- Do not submit proprietary assets, credentials, personal data, or material
  you do not have permission to redistribute.
- Keep pull requests focused and explain both what changed and why.

## Development

Use Node.js 22 and install the locked dependencies:

```powershell
npm ci
npm run test:unit
```

For gameplay or rendering work, follow [AGENTS.md](AGENTS.md). In particular,
run the browser automation harness and inspect its structured state, console
output, and rendered evidence. Generated files under `artifacts/` are local
test evidence and must not be committed.

Before submitting a pull request, run:

```powershell
npm run test:unit
npm run ai:test
```

Describe any checks you could not run. Visual changes should include a current
screenshot; animation, timing, camera, and effects changes should include a
recording or trace when practical.

## Pull requests

Pull requests must:

- pass CI and the relevant browser/gameplay checks;
- avoid unrelated formatting or generated-file churn;
- document user-visible behavior changes;
- include tests for new behavior where practical; and
- confirm that submitted work may be distributed under the MIT license.

By contributing, you license your contribution under the repository's MIT
license. Third-party assets are excluded as described in
[ASSET_NOTICE.md](ASSET_NOTICE.md).
