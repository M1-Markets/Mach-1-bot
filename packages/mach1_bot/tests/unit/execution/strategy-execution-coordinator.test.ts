import { StrategyExecutionCoordinator } from "@/domains/execution/strategy-execution-coordinator";

describe("StrategyExecutionCoordinator", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("executes immediately and then on interval", async () => {
        const executor = vi.fn(async () => undefined);
        const coordinator = new StrategyExecutionCoordinator({
            executor,
            intervalMs: 1000,
        });

        await coordinator.start();
        expect(executor).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(executor).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1000);
        expect(executor).toHaveBeenCalledTimes(3);
    });

    it("prevents overlapping execution when a tick is already in flight", async () => {
        let resolveTick: (() => void) | undefined;
        const longExecutor = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveTick = resolve;
                }),
        );

        const coordinator = new StrategyExecutionCoordinator({
            executor: longExecutor,
            intervalMs: 1000,
        });

        const startPromise = coordinator.start();
        expect(longExecutor).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(longExecutor).toHaveBeenCalledTimes(1);

        resolveTick?.();
        await startPromise;
    });

    it("stops and prevents later interval ticks", async () => {
        const executor = vi.fn(async () => undefined);
        const coordinator = new StrategyExecutionCoordinator({
            executor,
            intervalMs: 1000,
        });

        await coordinator.start();
        expect(executor).toHaveBeenCalledTimes(1);

        await coordinator.stop();
        await vi.advanceTimersByTimeAsync(3000);
        expect(executor).toHaveBeenCalledTimes(1);
    });

    it("waits for in-flight execution before stop resolves", async () => {
        let resolveTick: (() => void) | undefined;
        const executor = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveTick = resolve;
                }),
        );
        const coordinator = new StrategyExecutionCoordinator({
            executor,
            intervalMs: 1000,
        });

        const startPromise = coordinator.start();
        expect(executor).toHaveBeenCalledTimes(1);

        const stopPromise = coordinator.stop();
        let stopped = false;
        stopPromise.then(() => {
            stopped = true;
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);

        resolveTick?.();
        await startPromise;
        await stopPromise;

        expect(stopped).toBe(true);
        expect(coordinator.getStats().state).toBe("stopped");
    });

    it("supports manual logical-clock scheduling", async () => {
        const executor = vi.fn(async () => true);
        const coordinator = new StrategyExecutionCoordinator({
            executor,
            intervalMs: 5000,
        });

        await expect(coordinator.executeIfIntervalElapsed(1_000)).resolves.toBe(true);
        await expect(coordinator.executeIfIntervalElapsed(5_999)).resolves.toBe(false);
        await expect(coordinator.executeIfIntervalElapsed(6_000)).resolves.toBe(true);

        expect(executor).toHaveBeenCalledTimes(2);
        expect(coordinator.getStats().lastSuccessfulTick).toBe(6_000);
    });

    it("retries manual scheduling when executor skips tick", async () => {
        const executor = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const coordinator = new StrategyExecutionCoordinator({
            executor,
            intervalMs: 5000,
        });

        await expect(coordinator.executeIfIntervalElapsed(1_000)).resolves.toBe(false);
        await expect(coordinator.executeIfIntervalElapsed(1_001)).resolves.toBe(true);

        expect(executor).toHaveBeenCalledTimes(2);
        expect(coordinator.getStats().lastSuccessfulTick).toBe(1_001);
    });
});
