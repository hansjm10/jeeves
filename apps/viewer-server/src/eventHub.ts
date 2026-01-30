import type { ServerResponse } from 'node:http';

type SendFn = (event: string, data: unknown) => void;
type WsLike = Readonly<{ send(data: string): void }>;

export class EventHub {
  private readonly clients = new Map<number, SendFn>();
  private nextId = 1;

  addSseClient(res: ServerResponse): number {
    const id = this.nextId++;
    this.clients.set(id, (event, data) => {
      try {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        res.write(payload);
      } catch {
        // ignore; connection cleanup happens on close handlers
      }
    });
    return id;
  }

  addWsClient(socket: WsLike): number {
    const id = this.nextId++;
    this.clients.set(id, (event, data) => {
      try {
        socket.send(JSON.stringify({ event, data }));
      } catch {
        // ignore; connection cleanup happens on close handlers
      }
    });
    return id;
  }

  removeClient(id: number): void {
    this.clients.delete(id);
  }

  sendTo(id: number, event: string, data: unknown): void {
    const send = this.clients.get(id);
    if (!send) return;
    send(event, data);
  }

  broadcast(event: string, data: unknown): void {
    for (const send of this.clients.values()) {
      try {
        send(event, data);
      } catch {
        // ignore; connection cleanup happens on close handlers
      }
    }
  }
}
