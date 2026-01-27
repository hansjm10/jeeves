# Task Issues

The following issues need to be resolved:

1.  **Fix `createBrowserVitestConfig`**: Chain `mergeConfig` calls to correctly merge base config, browser config, and overrides.
2.  **Fix Dependencies**:
    - Move `vitest` and `vitest-llm-reporter` from `dependencies` to `devDependencies`. Keep them in `peerDependencies`.
    - Add `jsdom` to `peerDependencies` (and `devDependencies`).
