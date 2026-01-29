---
name: architecture-patterns
description: "Guide architectural decisions and design patterns. Use when designing new features, refactoring code, or reviewing system structure. Triggers on: design architecture, choose pattern, system design, component design."
---

# Architecture Patterns

Helps make informed architectural decisions during design phases.

---

## The Job

Guide the selection of appropriate design patterns and architectural approaches based on the problem domain and existing codebase patterns.

---

## Common Patterns

### Structural Patterns
- **Module Organization** - Group related functionality into cohesive modules
- **Registry Pattern** - Central registration point for dynamic components
- **Factory Pattern** - Encapsulate object creation logic

### Behavioral Patterns
- **Strategy Pattern** - Interchangeable algorithms behind common interface
- **Observer Pattern** - Event-driven communication between components
- **Command Pattern** - Encapsulate actions as objects

### Integration Patterns
- **Adapter Pattern** - Bridge between incompatible interfaces
- **Facade Pattern** - Simplified interface to complex subsystem
- **Plugin Architecture** - Extensibility through loadable components

---

## Decision Framework

When choosing an architecture approach:

1. **Analyze existing patterns** - What patterns does the codebase already use?
2. **Consider constraints** - Performance, maintainability, testability requirements
3. **Evaluate trade-offs** - Complexity vs flexibility, coupling vs cohesion
4. **Document decisions** - Record why a pattern was chosen

---

## Design Document Sections

A good design document includes:

```markdown
## Overview
[Problem statement and proposed solution]

## Architecture
[High-level system design]

## Key Design Decisions
[Patterns chosen and rationale]

## API/Interface Design
[Public interfaces and contracts]

## Implementation Plan
[Phased approach to implementation]

## Testing Strategy
[How the design will be validated]
```

---

## Anti-Patterns to Avoid

- **God classes** - Classes that do too much
- **Tight coupling** - Components that know too much about each other
- **Premature optimization** - Complexity without proven need
- **Inconsistent patterns** - Different approaches for similar problems
