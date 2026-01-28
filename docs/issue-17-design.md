---
title: Add Auto-Scroll Feature to SDK Output Viewer
sidebar_position: 7
---

# Add Auto-Scroll Feature to SDK Output Viewer

Use this document as the canonical design for implementing auto-scroll functionality in the SDK Output viewer (Conversation and Timeline views) to match the existing Log Output panel behavior.

## Document Control
- **Title**: Add Auto-Scroll Feature to SDK Output Viewer
- **Authors**: Jeeves Agent
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-01-28
- **Related Issues**: [#17](https://github.com/hansjm10/jeeves/issues/17)
- **Execution Mode**: AI-led

## 1. Summary

The SDK Output viewer currently lacks auto-scroll functionality, requiring users to manually scroll to see new messages and tool calls as they stream in via SSE. This design adds auto-scroll to the SDK Output viewer (both Conversation and Timeline views) with the same UX as the existing Log Output panel: enabled by default, smart detection when users scroll up, and re-enable via button click or End key.

## 2. Context & Problem Statement

- **Background**: The Jeeves Viewer (`viewer/static/index.html`) provides three main tabs: Logs, SDK, and Prompts. The Logs tab has a mature auto-scroll implementation that automatically scrolls to show new content as it arrives via SSE streaming. The SDK tab, which displays structured conversation output and tool call timelines, was updated in Issue #10 to support real-time SSE streaming but lacks auto-scroll functionality.
- **Problem**:
  1. SDK Output viewer has no auto-scroll despite receiving real-time updates via SSE (`sdk-init`, `sdk-message`, `sdk-tool`, `sdk-complete` events)
  2. Users must manually scroll to see new messages and tool calls as they stream in
  3. UX inconsistency between Log Output (has auto-scroll) and SDK Output (no auto-scroll)
- **Forces**:
  - Must maintain consistency with existing Log Output auto-scroll UX
  - Both Conversation and Timeline views need auto-scroll
  - Must not interfere with existing SDK panel functionality
  - Should persist auto-scroll state appropriately when switching between views

## 3. Goals & Non-Goals

### Goals
1. Add auto-scroll toggle button to SDK panel controls (alongside Refresh and Timeline buttons)
2. Enable auto-scroll by default for SDK Output viewer
3. Implement smart scroll detection (auto-disable when user scrolls up 50px from bottom)
4. Support re-enabling via button click
5. Support End key to jump to bottom (already exists for logs, extend to SDK)
6. Apply auto-scroll to both Conversation and Timeline views

### Non-Goals
- Changing Log Output auto-scroll behavior
- Adding auto-scroll state persistence to localStorage (match current log behavior which doesn't persist)
- Adding separate auto-scroll toggles for Conversation vs Timeline views

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Jeeves users viewing real-time SDK output
- **Agent Roles**:
  - **Implementation Agent**: Implements auto-scroll state, button, scroll listeners, and integration with render functions
- **Affected Packages/Services**:
  - `src/jeeves/viewer/static/index.html`:
    - Add `sdkAutoScroll` state variable (line ~1247)
    - Add auto-scroll button to SDK controls (line ~1219-1222)
    - Add scroll logic to `renderSdkConversation()` (line ~1491)
    - Add scroll logic to `renderSdkTimeline()` (line ~1525)
    - Add scroll detection listeners for `sdkConversation` and `sdkTimeline` containers
    - Extend End key handler to include SDK containers
- **Compatibility Considerations**:
  - No API changes required
  - No schema changes required
  - Purely frontend enhancement

## 5. Current State

### Current Log Output Auto-Scroll Implementation

The Log Output panel has a working auto-scroll implementation at `viewer/static/index.html`:

**State Variable** (line ~1247):
```javascript
let autoScroll = true;
```

**Toggle Button** (line ~1179):
```html
<button class="log-btn active" id="btnAutoScroll">Auto-scroll</button>
```

**Button Handler** (lines ~2673-2679):
```javascript
btnAutoScroll.addEventListener('click', () => {
    autoScroll = !autoScroll;
    btnAutoScroll.classList.toggle('active', autoScroll);
    if (autoScroll) {
        logContent.scrollTop = logContent.scrollHeight;
    }
});
```

**Smart Scroll Detection** (lines ~2727-2734):
```javascript
logContent.addEventListener('scroll', () => {
    const isAtBottom = logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < 50;
    if (!isAtBottom && autoScroll) {
        autoScroll = false;
        btnAutoScroll.classList.remove('active');
    }
});
```

**Scroll on Render** (line ~2524, ~2661):
```javascript
if (autoScroll) {
    logContent.scrollTop = logContent.scrollHeight;
}
```

### Current SDK Output Panel Structure

**SDK Panel Controls** (lines ~1219-1222):
```html
<div class="sdk-controls">
    <button class="log-btn" id="btnSdkRefresh">Refresh</button>
    <button class="log-btn" id="btnSdkTimeline">Timeline</button>
</div>
```

**Scrollable Containers** (lines ~1224-1232):
```html
<div class="sdk-content" id="sdkContent">
    <div class="sdk-conversation" id="sdkConversation">...</div>
    <div class="sdk-timeline" id="sdkTimeline" style="display: none;"></div>
</div>
```

**CSS for Scrollable Containers** (lines ~650-658):
```css
.sdk-conversation {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    ...
}
```

### Current SDK Render Functions

**renderSdkConversation()** (line ~1447): Renders messages to `sdkConversation` element but has no scroll logic.

**renderSdkTimeline()** (line ~1494): Renders tool calls to `sdkTimeline` element but has no scroll logic.

### Current SSE Event Handling

SDK output updates arrive via SSE events (`sdk-init`, `sdk-message`, `sdk-tool`, `sdk-complete`) which trigger `renderSdkOutput()` (line ~1825), calling either `renderSdkConversation()` or `renderSdkTimeline()`.

## 6. Proposed Solution

### 6.1 Architecture Overview

Add a parallel auto-scroll system for SDK Output that mirrors the Log Output implementation:
1. New state variable `sdkAutoScroll` (separate from `autoScroll` for logs)
2. New button `btnSdkAutoScroll` in SDK controls
3. Scroll listeners on both `sdkConversation` and `sdkTimeline` containers
4. Auto-scroll logic in both `renderSdkConversation()` and `renderSdkTimeline()`
5. Extended End key handler for SDK containers

### 6.2 Detailed Design

#### 6.2.1 State Variable

Add after existing `autoScroll` variable (line ~1247):
```javascript
let sdkAutoScroll = true;
```

#### 6.2.2 SDK Controls Button

Modify SDK controls section (line ~1219-1222) to add auto-scroll button:
```html
<div class="sdk-controls">
    <button class="log-btn" id="btnSdkRefresh">Refresh</button>
    <button class="log-btn" id="btnSdkTimeline">Timeline</button>
    <button class="log-btn active" id="btnSdkAutoScroll">Auto-scroll</button>
</div>
```

#### 6.2.3 Element References

Add reference after existing element references (around line ~1628):
```javascript
const btnSdkAutoScroll = document.getElementById('btnSdkAutoScroll');
```

#### 6.2.4 Button Click Handler

Add after existing SDK button handlers (around line ~1760):
```javascript
if (btnSdkAutoScroll) btnSdkAutoScroll.addEventListener('click', () => {
    sdkAutoScroll = !sdkAutoScroll;
    btnSdkAutoScroll.classList.toggle('active', sdkAutoScroll);
    if (sdkAutoScroll) {
        const activeContainer = sdkShowTimeline
            ? document.getElementById('sdkTimeline')
            : document.getElementById('sdkConversation');
        if (activeContainer) {
            activeContainer.scrollTop = activeContainer.scrollHeight;
        }
    }
});
```

#### 6.2.5 Scroll Detection Listeners

Add after SDK button handlers:
```javascript
// SDK auto-scroll detection for Conversation view
const sdkConvEl = document.getElementById('sdkConversation');
if (sdkConvEl) sdkConvEl.addEventListener('scroll', () => {
    const isAtBottom = sdkConvEl.scrollHeight - sdkConvEl.scrollTop - sdkConvEl.clientHeight < 50;
    if (!isAtBottom && sdkAutoScroll) {
        sdkAutoScroll = false;
        if (btnSdkAutoScroll) btnSdkAutoScroll.classList.remove('active');
    }
});

// SDK auto-scroll detection for Timeline view
const sdkTimeEl = document.getElementById('sdkTimeline');
if (sdkTimeEl) sdkTimeEl.addEventListener('scroll', () => {
    const isAtBottom = sdkTimeEl.scrollHeight - sdkTimeEl.scrollTop - sdkTimeEl.clientHeight < 50;
    if (!isAtBottom && sdkAutoScroll) {
        sdkAutoScroll = false;
        if (btnSdkAutoScroll) btnSdkAutoScroll.classList.remove('active');
    }
});
```

#### 6.2.6 Render Function Updates

**renderSdkConversation()** - Add at end of function (after line ~1491):
```javascript
if (sdkAutoScroll) {
    convEl.scrollTop = convEl.scrollHeight;
}
```

**renderSdkTimeline()** - Add at end of function (after line ~1525):
```javascript
if (sdkAutoScroll) {
    timelineEl.scrollTop = timelineEl.scrollHeight;
}
```

#### 6.2.7 End Key Handler Extension

Modify existing End key handler (line ~2722-2724) to include SDK containers:
```javascript
if (e.key === 'End') {
    if (mainTab === 'logs') {
        logContent.scrollTop = logContent.scrollHeight;
    } else if (mainTab === 'sdk') {
        const activeContainer = sdkShowTimeline
            ? document.getElementById('sdkTimeline')
            : document.getElementById('sdkConversation');
        if (activeContainer) {
            activeContainer.scrollTop = activeContainer.scrollHeight;
        }
    }
}
```

### 6.3 Operational Considerations

- **Deployment**: No special deployment requirements; single file change
- **Telemetry & Observability**: N/A - purely UI enhancement
- **Security & Compliance**: N/A - no new data handling

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| T1: Add SDK auto-scroll state and button | Add `sdkAutoScroll` state variable and button to SDK controls | Implementation Agent | None | Button visible in SDK panel, toggles `active` class |
| T2: Implement button click handler | Wire up button click to toggle state and scroll to bottom | Implementation Agent | T1 | Clicking button toggles state and scrolls when enabled |
| T3: Add scroll detection listeners | Add scroll listeners to both containers for smart detection | Implementation Agent | T1 | Scrolling up disables auto-scroll and removes `active` class |
| T4: Update render functions with auto-scroll | Add scroll-to-bottom logic in renderSdkConversation and renderSdkTimeline | Implementation Agent | T1 | New content triggers auto-scroll when enabled |
| T5: Extend End key handler | Update keyboard handler to scroll SDK containers | Implementation Agent | T1 | End key scrolls active SDK container to bottom |
| T6: Manual testing and verification | Test all acceptance criteria from issue | Implementation Agent | T1-T5 | All acceptance criteria pass |

### 7.2 Milestones

- **Phase 1**: Core Implementation (T1-T5) - Single implementation pass
- **Phase 2**: Verification (T6) - Manual testing of all acceptance criteria

### 7.3 Coordination Notes

- **Hand-off Package**: This design document, issue #17, existing Log Output auto-scroll code as reference
- **Communication Cadence**: N/A - single-agent execution

## 8. Agent Guidance & Guardrails

- **Context Packets**:
  - `src/jeeves/viewer/static/index.html` - main file to modify
  - GitHub Issue #17 - acceptance criteria
- **Prompting & Constraints**:
  - Follow existing code patterns from Log Output auto-scroll
  - Use same 50px threshold for scroll detection
  - Use same `log-btn` and `active` classes for button styling
- **Safety Rails**:
  - Do not modify Log Output auto-scroll behavior
  - Maintain existing SDK panel functionality
  - Test both Conversation and Timeline views
- **Validation Hooks**:
  - Open viewer in browser
  - Verify auto-scroll button appears and is active by default
  - Trigger SDK streaming (run a task) and verify auto-scroll
  - Scroll up manually, verify auto-scroll disables
  - Click button, verify re-enables and scrolls to bottom
  - Press End key, verify scrolls to bottom
  - Switch to Timeline view, verify auto-scroll works there too

## 9. Alternatives Considered

### Alternative A: Shared auto-scroll state with Log Output
- **Rejected**: Could cause confusion when switching tabs; Log and SDK views have different content and users may want different scroll behaviors per tab.

### Alternative B: Separate auto-scroll toggles for Conversation vs Timeline
- **Rejected**: Adds unnecessary complexity; users typically want consistent behavior within the SDK panel regardless of active view.

### Alternative C: localStorage persistence of SDK auto-scroll state
- **Rejected**: Current Log Output auto-scroll doesn't persist state; maintain consistency with existing behavior.

## 10. Testing & Validation Plan

### Manual Testing Checklist
1. **Button visibility**: Auto-scroll button visible in SDK panel controls
2. **Default state**: Auto-scroll enabled by default (button has `active` class)
3. **Auto-scroll on new messages**: When SDK output streams in, view scrolls to bottom
4. **Smart detection - Conversation**: Scroll up in Conversation view, auto-scroll disables
5. **Smart detection - Timeline**: Scroll up in Timeline view, auto-scroll disables
6. **Button re-enable**: Click button, auto-scroll re-enables and scrolls to bottom
7. **End key**: Press End key in SDK tab, scrolls to bottom
8. **View switching**: Switch between Conversation/Timeline, auto-scroll state persists

### Edge Cases
- Empty SDK output (no messages) - no errors
- Very long conversations (100+ messages) - performance acceptable
- Rapid SSE updates - scroll behavior smooth

## 11. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Performance with large message counts | Low | Medium | Use same approach as Log Output which handles 5000+ lines |
| Scroll detection race conditions | Low | Low | Same pattern works for Log Output without issues |

## 12. Rollout Plan

- **Milestones**: Single release with all functionality
- **Migration Strategy**: N/A - new feature, no migration needed
- **Communication**: Update issue #17 when complete

## 13. Open Questions

None - implementation approach is well-defined based on existing Log Output auto-scroll.

## 14. Follow-Up Work

- Consider adding scroll-to-bottom indicator when auto-scroll is disabled (future enhancement)
- Consider persisting auto-scroll preference in localStorage (if users request it)

## 15. References

- Issue #17: https://github.com/hansjm10/jeeves/issues/17
- Issue #10 Design: `docs/issue-10-design.md` (SDK streaming implementation)
- Source: `src/jeeves/viewer/static/index.html`
  - Log auto-scroll state: line ~1247
  - Log auto-scroll button: line ~1179
  - Log scroll detection: lines ~2727-2734
  - SDK controls: lines ~1219-1222
  - SDK containers: lines ~1224-1232
  - renderSdkConversation: line ~1447
  - renderSdkTimeline: line ~1494

## Appendix A - Glossary

- **SSE**: Server-Sent Events - real-time streaming protocol used by viewer
- **SDK Output**: Structured conversation output showing messages and tool calls
- **Conversation View**: Shows messages in conversation format
- **Timeline View**: Shows tool calls with duration bars

## Appendix B - Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2026-01-28 | Jeeves Agent | Initial draft |
