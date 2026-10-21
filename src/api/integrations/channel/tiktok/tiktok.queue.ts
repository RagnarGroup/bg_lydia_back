// LYD-95: TikTok puede entregar eventos de una misma conversacion en paralelo o fuera de orden; se
// procesan de a uno por clave (business_id + conversation_id). Un fallo no bloquea la cola de esa clave.
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);

    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });

    return result;
  }
}
