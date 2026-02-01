export function WorkflowsPage() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '280px 1fr 320px',
        gap: 12,
        padding: 12,
        alignItems: 'stretch',
      }}
    >
      <section
        aria-label="workflow list"
        style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, minHeight: 240 }}
      >
        <h2 style={{ margin: 0, fontSize: 14 }}>Workflows</h2>
        <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.75 }}>List placeholder</p>
      </section>
      <section
        aria-label="workflow graph"
        style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, minHeight: 240 }}
      >
        <h2 style={{ margin: 0, fontSize: 14 }}>Graph</h2>
        <div style={{ marginTop: 8, height: 360, border: '1px dashed #bbb', borderRadius: 6 }} />
      </section>
      <section
        aria-label="workflow inspector"
        style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, minHeight: 240 }}
      >
        <h2 style={{ margin: 0, fontSize: 14 }}>Inspector</h2>
        <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.75 }}>Inspector placeholder</p>
      </section>
    </div>
  );
}

