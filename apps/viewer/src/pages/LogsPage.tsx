import { useViewerStream } from '../stream/ViewerStreamProvider.js';
import { LogPanel } from '../ui/LogPanel.js';

export function LogsPage() {
  const stream = useViewerStream();
  return <LogPanel title="Live logs" lines={stream.logs} />;
}

