import type { ClientMsg, ServerMsg } from "@agentworld/protocol";

/** Thin typed wrapper around the game WebSocket. */
export class Net {
  private ws: WebSocket | null = null;

  constructor(
    private readonly url: string,
    private readonly onMsg: (msg: ServerMsg) => void,
    private readonly onDisconnect: () => void,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Could not reach ${this.url}`));
      ws.onclose = () => this.onDisconnect();
      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return; // ignore malformed frames
        }
        this.onMsg(msg);
      };
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
