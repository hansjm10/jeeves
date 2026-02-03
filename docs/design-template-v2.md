# Design: [Feature Name]

**Issue**: #[number]
**Status**: Draft
**Feature Types**: Primary: [type], Secondary: [types or "None"]

---

## 1. Scope

### Problem
[1-2 sentence problem statement - what's broken or missing today]

### Goals
- [ ] [Concrete, measurable outcome 1]
- [ ] [Concrete, measurable outcome 2]
- [ ] [Concrete, measurable outcome 3]

### Non-Goals
- [Explicit exclusion 1 - what we're NOT doing]
- [Explicit exclusion 2]

### Boundaries
- **In scope**: [what's included]
- **Out of scope**: [what's adjacent but excluded]

---

## 2. Workflow

### States
| State | Description | Entry Condition |
|-------|-------------|-----------------|
| | | |

### Transitions
| From | Event/Condition | To | Side Effects |
|------|-----------------|-----|--------------|
| | | | |

### Error Handling
| State | Error | Recovery State | Actions |
|-------|-------|----------------|---------|
| | | | |

### Crash Recovery
- **Detection**: [how we know recovery is needed]
- **Recovery state**: [what state we resume in]
- **Cleanup**: [what we do before resuming]

*Or: "N/A - This feature does not involve workflow or state machine changes."*

---

## 3. Interfaces

### Endpoints
| Method | Path | Input | Success | Errors |
|--------|------|-------|---------|--------|
| | | | | |

### Events
| Event | Trigger | Payload | Consumers |
|-------|---------|---------|-----------|
| | | | |

### Validation Rules
| Field | Type | Constraints | Error Message |
|-------|------|-------------|---------------|
| | | | |

*Or: "N/A - This feature does not add or modify external interfaces."*

---

## 4. Data

### Schema Changes
| Location | Field | Type | Required | Default | Constraints |
|----------|-------|------|----------|---------|-------------|
| | | | | | |

### Migrations
| Change | Existing Data Handling | Rollback |
|--------|------------------------|----------|
| | | |

### Artifacts
| Artifact | Location | On Success | On Failure | On Crash |
|----------|----------|------------|------------|----------|
| | | | | |

*Or: "N/A - This feature does not add or modify data schemas."*

---

## 5. Tasks

### Dependency Graph
```
T1 (no deps)
T2 → depends on T1
T3 → depends on T1, T2
```

### Task Breakdown
| ID | Title | Files | Acceptance Criteria |
|----|-------|-------|---------------------|
| T1 | | | |
| T2 | | | |
| T3 | | | |

### Task Details

**T1: [Title]**
- Summary: [what this accomplishes]
- Files: `path/to/file.ts`
- Acceptance Criteria:
  1. [Specific, verifiable]
  2. [Specific, verifiable]
- Verification: `[test command]`

---

## 6. Validation

### Pre-Implementation
```bash
pnpm install
pnpm typecheck
pnpm test
```

### Post-Implementation
```bash
pnpm typecheck
pnpm lint
pnpm test
```

### New Tests
- [ ] `path/to/new.test.ts` - [what it tests]
