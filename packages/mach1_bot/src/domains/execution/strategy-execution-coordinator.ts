export type StrategyExecutionCoordinatorState =
    | "idle"
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "error";

export interface StrategyExecutionCoordinatorStats {
    state: StrategyExecutionCoordinatorState;
    intervalMs: number;
    inFlight: boolean;
    lastTickStart?: number;
    lastTickEnd?: number;
    lastSuccessfulTick?: number;
    lastError?: string | null;
}

export interface StrategyExecutionCoordinatorOptions {
    executor: () => Promise<boolean | void>;
    intervalMs: number;
    now?: () => number;
}

export class StrategyExecutionCoordinator {
    private state: StrategyExecutionCoordinatorState = "idle";
    private readonly intervalMs: number;
    private readonly executor: () => Promise<boolean | void>;
    private readonly now: () => number;
    private intervalId?: NodeJS.Timeout;
    private inFlight = false;
    private currentTick?: Promise<void>;
    private lastTickStart?: number;
    private lastTickEnd?: number;
    private lastSuccessfulTick?: number;
    private lastError: Error | null = null;

    constructor(options: StrategyExecutionCoordinatorOptions) {
        this.executor = options.executor;
        this.intervalMs = options.intervalMs;
        this.now = options.now ?? Date.now;
    }

    async start(): Promise<void> {
        if (this.intervalId || this.state === "running" || this.state === "starting") {
            return;
        }

        this.state = "starting";
        this.intervalId = setInterval(() => {
            void this.tick();
        }, this.intervalMs);

        await this.executeNow();
    }

    async stop(): Promise<void> {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }

        this.state = "stopping";
        if (this.currentTick) {
            await this.currentTick;
            return;
        }

        this.state = "stopped";
    }

    async executeNow(): Promise<void> {
        await this.tick();
    }

    async executeIfIntervalElapsed(timestamp = this.now()): Promise<boolean> {
        if (
            this.lastSuccessfulTick !== undefined &&
            timestamp - this.lastSuccessfulTick < this.intervalMs
        ) {
            return false;
        }

        const previousSuccessfulTick = this.lastSuccessfulTick;
        await this.tick(timestamp);
        return this.lastSuccessfulTick !== previousSuccessfulTick;
    }

    getStats(): StrategyExecutionCoordinatorStats {
        return {
            state: this.state,
            intervalMs: this.intervalMs,
            inFlight: this.inFlight,
            lastTickStart: this.lastTickStart,
            lastTickEnd: this.lastTickEnd,
            lastSuccessfulTick: this.lastSuccessfulTick,
            lastError: this.lastError?.message ?? null,
        };
    }

    private async tick(timestamp = this.now()): Promise<void> {
        if (this.inFlight) {
            await this.currentTick;
            return;
        }

        this.currentTick = (async () => {
            this.inFlight = true;
            this.lastTickStart = timestamp;

            try {
                const executed = await this.executor();
                if (executed !== false) {
                    this.lastSuccessfulTick = timestamp;
                    this.lastError = null;
                }
                if (this.state !== "stopping") {
                    this.state = "running";
                }
            } catch (error) {
                this.lastError = error instanceof Error ? error : new Error(String(error));
                this.state = "error";
            } finally {
                this.lastTickEnd = timestamp;
                this.inFlight = false;
                if (this.state === "stopping") {
                    this.state = "stopped";
                }
                this.currentTick = undefined;
            }
        })();

        await this.currentTick;
    }
}
