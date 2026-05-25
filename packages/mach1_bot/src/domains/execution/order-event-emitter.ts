import { EventEmitter } from "events";
import type { OrderLifecycleEvent } from "@/shared/types";

type OrderEventListener = (event: OrderLifecycleEvent) => void | Promise<void>;

export class OrderEventEmitter {
  private readonly emitter = new EventEmitter();

  on(listener: OrderEventListener): () => void {
    this.emitter.on("order", listener);
    return () => {
      this.emitter.off("order", listener);
    };
  }

  emit(event: OrderLifecycleEvent): void {
    this.emitter.emit("order", event);
  }
}
