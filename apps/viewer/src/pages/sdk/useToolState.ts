import { useMemo } from 'react';
import type { SdkEvent, SdkToolStartData, SdkToolCompleteData } from '../../api/types.js';

export type ToolStatus = 'running' | 'completed' | 'error';

export type ToolState = {
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  duration_ms?: number;
  response_text?: string;
  response_truncated?: boolean;
  response_compression?: Record<string, unknown>;
  response_retrieval?: Record<string, unknown>;
  timestamp: number;
  order: number;
};

/**
 * Hook that correlates sdk-tool-start and sdk-tool-complete events by tool_use_id.
 * Returns tools in arrival order for timeline display.
 */
export function useToolState(sdkEvents: readonly SdkEvent[]): ToolState[] {
  return useMemo(() => {
    const toolMap = new Map<string, ToolState>();
    const orderedIds: string[] = [];
    let order = 0;

    for (const event of sdkEvents) {
      if (event.event === 'sdk-tool-start') {
        const data = event.data as SdkToolStartData;
        if (!toolMap.has(data.tool_use_id)) {
          orderedIds.push(data.tool_use_id);
          toolMap.set(data.tool_use_id, {
            tool_use_id: data.tool_use_id,
            name: data.name,
            input: data.input,
            status: 'running',
            timestamp: Date.now() - (sdkEvents.length - order) * 100,
            order: order++,
          });
        }
      } else if (event.event === 'sdk-tool-complete') {
        const data = event.data as SdkToolCompleteData;
        const existing = toolMap.get(data.tool_use_id);
        if (existing) {
          toolMap.set(data.tool_use_id, {
            ...existing,
            status: data.is_error ? 'error' : 'completed',
            duration_ms: data.duration_ms,
            ...(data.response_text !== undefined ? { response_text: data.response_text } : {}),
            ...(data.response_truncated !== undefined ? { response_truncated: data.response_truncated } : {}),
            ...(data.response_compression !== undefined
              ? { response_compression: data.response_compression }
              : {}),
            ...(data.response_retrieval !== undefined
              ? { response_retrieval: data.response_retrieval }
              : {}),
          });
        }
      }
    }

    // Return tools in arrival order
    return orderedIds.map(id => toolMap.get(id)!);
  }, [sdkEvents]);
}
