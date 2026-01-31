import { useViewerStream } from '../stream/ViewerStreamProvider.js';

export function SdkPage() {
  const stream = useViewerStream();
  return (
    <div className="panel">
      <div className="panelTitle">SDK events</div>
      <div className="panelBody">
        <div className="muted">showing last {stream.sdkEvents.length} events</div>
        <pre className="log">{stream.sdkEvents.map((e) => JSON.stringify(e, null, 2)).join('\n')}</pre>
      </div>
    </div>
  );
}

