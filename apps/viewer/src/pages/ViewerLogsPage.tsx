import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { LogPanel } from '../ui/LogPanel.js';

export function ViewerLogsPage() {
  const stream = useViewerStream();
  return <LogPanel title="Viewer logs" lines={stream.viewerLogs} />;
}

