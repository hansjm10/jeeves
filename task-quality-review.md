# Task Quality Review

## Task: T1 - feat(config-vitest): scaffold package

**Summary:**
The package structure exists and basic configuration is in place. However, critical issues were found in the implementation logic (T2 scope but implemented) and dependency configuration.

**Findings:**
1.  **Incorrect `mergeConfig` Usage (Critical)**: In `packages/config-vitest/index.js`, `createBrowserVitestConfig` passes three arguments to `mergeConfig`. `mergeConfig` only supports merging two configurations at a time. The third argument (overrides) will likely be ignored or cause errors.
    ```javascript
    return mergeConfig(
      BASE_CONFIG,
      defineConfig({ ... }),
      overrides // 3rd arg ignored
    );
    ```
2.  **Redundant Dependencies**: `vitest` and `vitest-llm-reporter` are listed in both `dependencies` and `peerDependencies`. This is redundant.
3.  **Missing Dependency**: `jsdom` is used in `createBrowserVitestConfig` but is not listed in `package.json`.

**Recommendation:**
- Refactor `createBrowserVitestConfig` to chain `mergeConfig` calls.
- Move `vitest` and `vitest-llm-reporter` to `devDependencies` (and keep in `peerDependencies`).
- Add `jsdom` to `peerDependencies` (and `devDependencies` for local testing if needed).
