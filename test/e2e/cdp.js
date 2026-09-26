// Minimal Chrome DevTools Protocol client over the WebSocket built into Node.
// Enough for these tests: talk to the browser endpoint, load the unpacked
// extension, open tabs, and evaluate inside the service worker.
const liveSockets = new Set();

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.pending = new Map();
    this.nextId = 0;
    this.onEvent = () => {};
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method) this.onEvent(message);
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    liveSockets.add(ws);
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("cannot open " + url));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Throws on an exception so a typo in an expression fails the test instead of
  // silently yielding undefined.
  async eval(expression, awaitPromise = false) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text;
      throw new Error("evaluate failed: " + detail);
    }
    return result.result.value;
  }

  close() {
    liveSockets.delete(this.ws);
    try {
      this.ws.close();
    } catch {}
  }
}

function closeAll() {
  for (const ws of liveSockets) {
    try {
      ws.close();
    } catch {}
  }
  liveSockets.clear();
}

module.exports = { CDP, closeAll };