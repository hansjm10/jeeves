import { describe, expect, it } from 'vitest';

import { MAX_LOG_LINES, MAX_SDK_EVENTS, capArray, streamReducer } from './streamReducer.js';
import type { StreamState } from './streamTypes.js';

function makeState(): StreamState {
  return {
    connected: false,
    lastError: null,
    state: null,
    logs: [],
    viewerLogs: [],
    sdkEvents: [],
  };
}

describe('capArray', () => {
  it('keeps the last N items', () => {
    expect(capArray([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });
});

describe('streamReducer logs', () => {
  it('appends logs by default', () => {
    const s1 = makeState();
    const s2 = streamReducer(s1, { type: 'logs', data: { lines: ['a'] } });
    const s3 = streamReducer(s2, { type: 'logs', data: { lines: ['b'] } });
    expect(s3.logs).toEqual(['a', 'b']);
  });

  it('resets logs when reset=true', () => {
    const s1 = makeState();
    const s2 = streamReducer(s1, { type: 'logs', data: { lines: ['a', 'b'] } });
    const s3 = streamReducer(s2, { type: 'logs', data: { lines: ['x'], reset: true } });
    expect(s3.logs).toEqual(['x']);
  });
});

describe('streamReducer sdk', () => {
  it('caps sdk events', () => {
    let state = makeState();
    for (let i = 0; i < MAX_SDK_EVENTS + 10; i += 1) {
      state = streamReducer(state, { type: 'sdk', event: 'e', data: { i } });
    }
    expect(state.sdkEvents.length).toBe(MAX_SDK_EVENTS);
    expect(state.sdkEvents[0]?.data).toEqual({ i: 10 });
  });
});

describe('streamReducer log capping', () => {
  it('caps log lines', () => {
    let state = makeState();
    for (let i = 0; i < MAX_LOG_LINES + 5; i += 1) {
      state = streamReducer(state, { type: 'logs', data: { lines: [`${i}`] } });
    }
    expect(state.logs.length).toBe(MAX_LOG_LINES);
    expect(state.logs[0]).toBe('5');
  });
});

