import { EventEmitter } from "events";
import type { OrderLifecycleEvent } from "@/shared/types";

type OrderEventListener = (event: OrderLifecycleEvent) => void | Promise<void>;

export class OrderEventEmitter {
  private readonly emitter = new EventEmitter();
  private readonly pendingListeners = new Set<Promise<void>>();

  on(listener: OrderEventListener): () => void {
    this.emitter.on("order", listener);
    return () => {
      this.emitter.off("order", listener);
    };
  }

  emit(event: OrderLifecycleEvent): void {
    for (const listener of this.emitter.listeners(
      "order",
    ) as OrderEventListener[]) {
      const result = listener(event);
      if (result instanceof Promise) {
        const pending = result.finally(() => {
          this.pendingListeners.delete(pending);
        });
        this.pendingListeners.add(pending);
        void pending.catch(() => undefined);
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingListeners.size > 0) {
      await Promise.all([...this.pendingListeners]);
    }
  }
}
