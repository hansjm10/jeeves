# Design Document: Add --work-dir Option to viewer/server.py

## Overview

**Issue:** [#3 - Add --work-dir option to viewer/server.py](https://github.com/hansjm10/jeeves/issues/3)

**Summary:** Add an explicit `--work-dir` CLI argument to `viewer/server.py` that allows users to specify the project working directory directly, rather than always deriving it from `state_dir.parent`.

## Problem Statement

When running the Jeeves viewer server where the project root IS the jeeves directory itself (e.g., `/work/jeeves/`), the server incorrectly determines the working directory.

### Current Behavior

The `work_dir` is derived as `state_dir.parent` in the `JeevesRunManager` initialization:

```python
# Line 1463-1464 in server.py
run_manager = JeevesRunManager(
    ...
    work_dir=Path(state_dir).resolve().parent,
)
```

This assumes the `jeeves/` folder is always a subfolder inside a project.

### Problem Scenario

When the project IS the jeeves repo itself:
- If `state_dir` = `/work/jeeves/` (git root + "jeeves")
- Then `work_dir` = `/work/` (parent container - **WRONG**)

The workaround is to create a `jeeves/` subfolder inside the project for state files, but this is inconvenient and non-obvious.

## Proposed Solution

Add an explicit `--work-dir` / `-w` CLI argument that allows users to override the automatic `work_dir` derivation.

### Interface Changes

**New CLI argument:**
```
--work-dir, -w   Project working directory (defaults to state-dir parent)
```

**Usage examples:**
```bash
# Explicit work directory
python3 viewer/server.py --state-dir /work/jeeves/jeeves --work-dir /work/jeeves

# Short form
python3 viewer/server.py -s /work/jeeves/jeeves -w /work/jeeves

# Default behavior (unchanged)
python3 viewer/server.py --state-dir /work/project/jeeves
# work_dir automatically = /work/project
```

### Code Changes

#### 1. Add argument to parser (in `main()`)

```python
parser.add_argument(
    "--work-dir", "-w",
    type=str,
    help="Project working directory (defaults to state-dir parent)"
)
```

#### 2. Update work_dir derivation (in `main()`)

```python
# After state_dir is determined
if args.work_dir:
    work_dir = Path(args.work_dir).resolve()
else:
    work_dir = Path(state_dir).resolve().parent

run_manager = JeevesRunManager(
    state_dir=Path(state_dir),
    jeeves_script=(jeeves_root / "bin" / "jeeves.sh"),
    work_dir=work_dir,
)
```

#### 3. Update startup message

```python
print(f"  State directory: {state_dir}")
print(f"  Work directory:  {work_dir}")  # Add this line
print(f"  Server: http://localhost:{args.port}")
```

## Design Considerations

### Alternative Approaches Considered

1. **Auto-detect when state_dir IS the git root** - Rejected because it adds complexity and edge cases. An explicit flag is clearer.

2. **Environment variable `JEEVES_WORK_DIR`** - Could be added later, but CLI argument is the primary interface. The `JeevesRunManager` already sets `JEEVES_WORK_DIR` environment variable for child processes.

3. **Change default behavior** - Rejected because it would break existing workflows that rely on the current convention.

### Validation

The `--work-dir` path should:
- Be resolved to an absolute path
- Existence is NOT required at startup (it may be created later)
- Invalid paths will cause natural failures when `JeevesRunManager.start()` runs git/shell commands

### Compatibility

- **Backward compatible**: Default behavior unchanged when `--work-dir` is not specified
- **No breaking changes**: All existing invocations continue to work

## Work Breakdown & Delivery Plan

### Task 1: Add CLI argument parsing

**Summary:** Add the `--work-dir`/`-w` argument to the argument parser.

**Acceptance Criteria:**
- [ ] `--work-dir` and `-w` flags are recognized
- [ ] Argument accepts a string path value
- [ ] Help text is displayed with `--help`

### Task 2: Implement work_dir override logic

**Summary:** Update `main()` to use the provided `--work-dir` value when specified, falling back to `state_dir.parent` otherwise.

**Acceptance Criteria:**
- [ ] When `--work-dir` is provided, use it as `work_dir`
- [ ] When `--work-dir` is not provided, derive from `state_dir.parent` (existing behavior)
- [ ] Path is resolved to absolute path
- [ ] `JeevesRunManager` receives the correct `work_dir`

### Task 3: Update startup output

**Summary:** Add work directory to the startup banner for visibility.

**Acceptance Criteria:**
- [ ] Startup message shows "Work directory: <path>"
- [ ] Path shown matches the resolved work_dir being used

### Task 4: Add tests

**Summary:** Add unit tests for the new `--work-dir` functionality.

**Acceptance Criteria:**
- [ ] Test that `--work-dir` overrides default behavior
- [ ] Test that default behavior (no `--work-dir`) still derives from `state_dir.parent`
- [ ] Test both short (`-w`) and long (`--work-dir`) forms

## Testing Strategy

### Manual Testing

1. **With explicit work-dir:**
   ```bash
   python3 viewer/server.py -s /work/jeeves/jeeves -w /work/jeeves
   # Verify startup shows correct directories
   # Verify git operations use correct working directory
   ```

2. **Without work-dir (default):**
   ```bash
   python3 viewer/server.py -s /work/project/jeeves
   # Verify work_dir = /work/project
   ```

### Automated Testing

Add tests to `test_server.py` covering:
- Argument parsing for `--work-dir` and `-w`
- Work directory resolution logic
- Integration with `JeevesRunManager`

## Open Questions

None - the solution is straightforward and follows existing patterns in the codebase.

## References

- GitHub Issue: https://github.com/hansjm10/jeeves/issues/3
- Related code: `viewer/server.py` lines 1419-1492 (main function)
- Related class: `JeevesRunManager` (lines 465-673)
