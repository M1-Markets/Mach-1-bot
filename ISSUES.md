# mach1_bot Strategy Execution Improvements

## Rules

- Implement phases in listed order.
  - Do not start a later phase until earlier phase compiles and its touched tests pass.
  - Keep each checklist item in same phase small enough for one focused PR.
  - Prefer deleting duplicate execution paths over adding compatibility wrappers.
  - Reuse existing managers and types before adding new modules.
  - Add or update tests for each completed item.
  - Run `npm run typecheck` after changes that touch shared types, execution engines, strategy manager, risk manager, or bot public APIs.
  - Run targeted Vitest files for touched areas before checking off each item.
  - Do not introduce new runtime dependencies for utility logic unless existing code cannot cover it.
  - Do not use mock/fallback prices in live order execution.
  - Do not record strategy trades from submitted orders; record only confirmed fills.
  - Preserve fail-closed behavior for live trading risk, pricing, and balance validation.

## Phase 1: Unify Strategy Execution Control

- [x] Create one strategy execution coordinator.
  - [x] Add coordinator module under `packages/mach1_bot/src/domains/execution/`.
  - [x] Own one tick loop for strategy execution across live, paper, and backtest modes.
  - [x] Accept strategy callback or managed strategy instance as input.
  - [x] Accept execution interval from config/options instead of hardcoding `60000` or `300000`.
  - [x] Track coordinator state: `idle`, `starting`, `running`, `stopping`, `stopped`, `error`.
  - [x] Prevent overlapping ticks with an in-flight guard.
  - [x] Record last tick start, last tick end, last successful tick, and last error.
  - [x] Expose `start()`, `stop()`, `executeNow()`, and `getStats()`.
  - [x] Test immediate tick execution.
  - [x] Test interval tick execution.
  - [x] Test no overlapping execution when callback takes longer than interval.
  - [x] Test stop clears interval and prevents later ticks.

- [x] Route `Mach1Bot.goLive()` through coordinator.
  - [x] Remove local `setInterval` from `goLive`.
  - [x] Keep `activeIntervals` cleanup for old wait-for-trigger intervals only.
  - [x] Preserve immediate first strategy execution.
  - [x] Preserve strategy error logging without crashing process.
  - [x] Test `goLive()` starts exactly one coordinator loop.
  - [x] Test repeated `goLive()` does not create duplicate loops.

- [x] Route `LiveTradingEngine.startLiveTrading()` through coordinator or remove duplicate loop.
  - [x] Delete private live strategy interval when coordinator covers behavior.
  - [x] Keep live market-data connect/disconnect behavior.
  - [x] Keep `executeStrategyNow()` behavior by delegating to coordinator.
  - [x] Update `getStrategyExecutionStats()` to return coordinator stats.
  - [x] Test `startLiveTrading()` cannot create two active loops.
  - [x] Test `stopLiveTrading()` stops coordinator and market subscriptions.

- [x] Route `PaperTradingEngine.startPaperTrading()` through coordinator or remove duplicate loop.
  - [x] Delete private paper strategy interval when coordinator covers behavior.
  - [x] Preserve paper market-data connect/disconnect behavior.
  - [x] Preserve deterministic clock/RNG inputs.
  - [x] Update `getStrategyExecutionStats()` to return coordinator stats.
  - [x] Test paper mode uses configured interval instead of hardcoded `1000`.

- [x] Route `StrategyManager` scheduled execution through coordinator.
  - [x] Replace internal `setInterval` with coordinator instance per strategy.
  - [x] Preserve `maxExecutionsPerMinute`.
  - [x] Preserve `pauseStrategy()`, `resumeStrategy()`, and `stopStrategy()` semantics.
  - [x] Test pause stops ticks.
  - [x] Test resume restarts ticks.
  - [x] Test stop cleans coordinator resources.

## Phase 2: Standardize Execution Engine Contract

- [x] Add shared execution engine interface.
  - [x] Define interface in `packages/mach1_bot/src/shared/types/execution.ts`.
  - [x] Include `initialize?()`, `placeOrder()`, `cancelOrder()`, `getOrderStatus()`, `getPosition()`, `getBalance()`, `getExecutedTrades()`, and `getOrderHistory()`.
  - [x] Use existing `OrderRequest`, `OrderResult`, `TradingPair`, `Position`, and `Address` types.
  - [x] Add normalized order status union shared by live, paper, and backtest.
  - [x] Test TypeScript compatibility with live, paper, and backtest engines.

- [x] Make `LiveTradingEngine` implement shared execution engine interface.
  - [x] Return normalized order statuses.
  - [x] Preserve Monaco SDK initialization.
  - [x] Preserve live risk and pre-trade checks.
  - [x] Preserve retry behavior for retryable order-placement errors.
  - [x] Test type-level interface compliance.

- [x] Make `PaperTradingEngine` implement shared execution engine interface.
  - [x] Return normalized order statuses.
  - [x] Keep deterministic scheduler behavior.
  - [x] Keep simulated fills behind scheduler.
  - [x] Test type-level interface compliance.

- [x] Make `BacktestEngine` implement shared execution engine interface.
  - [x] Return normalized order statuses.
  - [x] Keep immediate historical fill model.
  - [x] Keep existing backtest report behavior.
  - [x] Test type-level interface compliance.

- [x] Route `Mach1Bot.buy()` and `Mach1Bot.sell()` through active execution engine.
  - [x] Select live engine for live mode.
  - [x] Select backtest engine for active backtest mode.
  - [x] Select paper/simulation engine for simulation mode.
  - [x] Remove duplicated live/backtest/simulation order branches.
  - [x] Keep public `BotOrder` return shape.
  - [x] Test buy/sell use active engine once per order.
  - [x] Test risk rejection stops order before engine call.

## Phase 3: Canonical Trading Pair And Symbol Resolution

- [x] Create canonical `TradingPairService`.
  - [x] Place under `packages/mach1_bot/src/domains/trading/`.
  - [x] Resolve symbol strings through Monaco resolver when SDK resolver exists.
  - [x] Resolve known simulation symbols through one local table when SDK resolver does not exist.
  - [x] Normalize separators so `ETH-USDC` and `ETH/USDC` map to same canonical symbol.
  - [x] Return contract addresses only from resolver/table.
  - [x] Reject unknown symbols instead of casting ticker names as addresses.
  - [x] Expose `resolveSymbol()`, `normalizeSymbol()`, `getAllSymbols()`, and `resolvePairFromContracts()`.
  - [x] Test live resolver path with mocked Monaco resolver.
  - [x] Test simulation fallback path.
  - [x] Test unknown symbol rejection.
  - [x] Test separator normalization.

- [x] Replace `Mach1Bot.parseSymbol()` hardcoded maps with `TradingPairService`.
  - [x] Remove local BTC/ETH/SOL mock map from `Mach1Bot`.
  - [x] Preserve current supported simulation symbols.
  - [x] Preserve live resolver error message with available symbols preview.
  - [x] Test live parse uses Monaco contract addresses.
  - [x] Test simulation parse uses one canonical table.

- [x] Replace `PaperTradingEngine.parseSymbolToPair()` hardcoded maps with `TradingPairService`.
  - [x] Remove engine-local token address map.
  - [x] Keep paper trading independent from live SDK initialization.
  - [x] Test paper market-data construction uses canonical pair addresses.

- [x] Replace `StrategyManager.resolveTradingPair()` fallback casts with `TradingPairService`.
  - [x] Remove `base as Address` and `quote as Address` fallback from split symbols.
  - [x] Ensure managed strategies cannot submit orders with ticker strings as token addresses.
  - [x] Test strategy signal for unknown pair records warning and skips order.

## Phase 4: Real Market Data For Strategy Context

- [x] Create one `MarketDataService`.
  - [x] Place under `packages/mach1_bot/src/domains/trading/`.
  - [x] Build `MarketData` from live OHLCV snapshots when available.
  - [x] Build `MarketData` from live orderbook snapshots when available.
  - [x] Build `MarketData` from backtest historical candles/trades in backtest mode.
  - [x] Build deterministic simulated `MarketData` in paper/simulation mode.
  - [x] Calculate spread and order-book depth consistently.
  - [x] Return empty data when live data unavailable instead of fake prices.
  - [x] Test live OHLCV path.
  - [x] Test orderbook depth path.
  - [x] Test backtest data path.
  - [x] Test simulation deterministic path.

- [x] Replace `StrategyManager.createStrategyContext()` fake OHLCV data.
  - [x] Remove zero `open`, `high`, `low`, `close`, and `volume` placeholders.
  - [x] Use `MarketDataService` for each subscribed pair.
  - [x] Skip strategy execution when required subscribed pair data missing.
  - [x] Add warning to strategy errors when market data missing.
  - [x] Test managed strategy receives non-placeholder data.
  - [x] Test managed strategy skips tick when live data unavailable.

- [x] Replace `Mach1Bot.generateMockMarketData()` direct `Math.random()` usage.
  - [x] Move simulation generation into `MarketDataService`.
  - [x] Inject deterministic RNG.
  - [x] Preserve ETH/USDC and BTC/USDC default output.
  - [x] Test same seed returns same market data.

- [x] Replace `LiveTradingEngine.constructLiveMarketData()` placeholder indicators.
  - [x] Use shared indicator helpers.
  - [x] Use real candle history when available.
  - [x] Keep neutral indicator only when insufficient candle history exists.
  - [x] Mark insufficient-history condition in metadata or warning.
  - [x] Test RSI/MACD generated from candles.

- [x] Replace `BacktestEngine` neutral RSI/MACD placeholders.
  - [x] Compute indicators from historical candle window.
  - [x] Keep neutral only when insufficient historical window exists.
  - [x] Test indicator output changes with historical data.

## Phase 5: Order Lifecycle And Fill-Based Accounting

- [x] Add order lifecycle store.
  - [x] Define order record with local id, engine id, exchange id, strategy id, pair, side, type, requested quantity, filled quantity, remaining quantity, average fill price, fees, slippage, timestamps, and status.
  - [x] Store every order submission.
  - [x] Update records only from engine result or fill event.
  - [x] Keep rejected order reason.
  - [x] Keep cancelled order reason.
  - [x] Test submitted-to-filled transition.
  - [x] Test submitted-to-rejected transition.
  - [x] Test partial fill transition.
  - [x] Test cancel transition.

- [x] Emit order events from execution engines.
  - [x] Add typed `OrderEventEmitter` or use existing EventEmitter pattern.
  - [x] Emit `submitted`, `accepted`, `partially_filled`, `filled`, `cancelled`, and `rejected`.
  - [x] Include normalized order record in event payload.
  - [x] Test live engine emits rejected event on pre-trade failure.
  - [x] Test paper engine emits fill event after scheduled fill.
  - [x] Test backtest engine emits filled event on immediate fill.

- [x] Wire `StrategyManager.onOrderEvent`.
  - [x] Subscribe strategy instances to order events.
  - [x] Call strategy `onOrderEvent` only for orders belonging to that strategy or subscribed pair.
  - [x] Preserve warning capture on handler failures.
  - [x] Test strategy receives fill event.
  - [x] Test unrelated strategy does not receive event.

- [x] Record strategy performance from fills only.
  - [x] Remove trade recording immediately after order submission.
  - [x] Record quantity, fill price, fee, slippage, and realized PnL from order lifecycle data.
  - [x] Update `totalTrades`, `winRate`, `profitFactor`, and drawdown only from closed/realized trades.
  - [x] Test rejected order does not count as trade.
  - [x] Test pending order does not count as trade.
  - [x] Test fill updates performance metrics.

- [x] Update live position/PnL accounting.
  - [x] Track average entry price from fills.
  - [x] Compute unrealized PnL from current market price and average entry.
  - [x] Remove live hardcoded `0n` unrealized PnL.
  - [x] Test buy fill creates entry price.
  - [x] Test current price above entry yields positive unrealized PnL.

## Phase 6: Live Safety Fixes

- [x] Remove live fake price fallback.
  - [x] Delete `$100` fallback from `LiveTradingEngine.getCurrentPrice()`.
  - [x] Throw typed price-unavailable error when live price cannot be derived.
  - [x] Ensure live order placement fails closed on missing orderbook/OHLCV/ticker data.
  - [x] Test live price failure rejects order before Monaco call.

- [x] Fix live order id mapping.
  - [x] Store local order id and SDK/exchange order id separately.
  - [x] Use SDK/exchange order id for Monaco `cancelOrder()`.
  - [x] Return public order id consistently.
  - [x] Test cancellation calls Monaco with SDK returned id.

- [x] Normalize live orderbook units.
  - [x] Parse orderbook price and quantity using resolver token decimals.
  - [x] Avoid direct `BigInt(bestAsk.price)` on decimal strings.
  - [x] Keep all internal order price/quantity units explicit.
  - [x] Test decimal orderbook price parsing.
  - [x] Test integer orderbook price parsing.

- [x] Add live tick fail-closed behavior.
  - [x] Skip strategy tick when any required live symbol lacks valid market data.
  - [x] Log one warning per skipped tick with missing symbols.
  - [x] Do not call strategy callback with partial data unless strategy explicitly subscribes to subset.
  - [x] Test missing live data prevents strategy callback.

## Phase 7: Risk Manager Corrections

- [x] Fix max-loss zero-balance division.
  - [x] If sell order position balance is `0n`, reject sell for insufficient position before dividing.
  - [x] Keep fail-open option only for tracking errors, not zero-balance state.
  - [x] Test zero-balance sell does not throw divide-by-zero.
  - [x] Test zero-balance sell rejects.

- [x] Replace random correlation check.
  - [x] Remove RNG-based correlation pass/fail.
  - [x] Use historical returns from market data service when enough data exists.
  - [x] Return warning-only unavailable result when not enough data exists.
  - [x] Test deterministic correlation result.
  - [x] Test insufficient data creates warning and does not randomize approval.

- [x] Emit risk events.
  - [x] Emit event on risk rejection.
  - [x] Emit event on risk warning above threshold.
  - [x] Include order id, pair, current value, limit value, and reason.
  - [x] Wire events to `StrategyManager.onRiskEvent`.
  - [x] Test strategy receives risk event.

- [x] Make risk units explicit.
  - [x] Document expected price and quantity scaling in type comments.
  - [x] Add helpers for notional value calculation.
  - [x] Replace repeated `(price * quantity) / 100n` with helper.
  - [x] Test helper with cents-style price and strategy quantity scale.

## Phase 8: Strategy Signal Validation

- [x] Add strategy signal validator.
  - [x] Validate action is supported.
  - [x] Validate pair exists in `TradingPairService`.
  - [x] Validate confidence is between `0` and `1`.
  - [x] Validate quantity is positive when action is `buy` or `sell`.
  - [x] Validate price is positive when order type requires price.
  - [x] Reject unsupported `stop`, `stop_limit`, `close_position`, and `reduce_position` until implemented.
  - [x] Return structured validation errors.
  - [x] Test invalid confidence.
  - [x] Test missing quantity.
  - [x] Test unsupported action.
  - [x] Test unknown pair.

- [x] Remove default strategy order quantity.
  - [x] Delete `BigInt(100000)` default quantity.
  - [x] Require explicit quantity or explicit sizing rule.
  - [x] For missing quantity, record strategy warning and skip signal.
  - [x] Test missing quantity does not place order.

- [x] Add explicit order type mapping.
  - [x] Map `market` to market execution.
  - [x] Map `limit` to limit execution.
  - [x] Reject `stop` and `stop_limit` until stop-order engine exists.
  - [x] Test each supported mapping.
  - [x] Test unsupported order type skips signal.

## Phase 9: Determinism And IDs

- [x] Replace `Math.random()` in order ids.
  - [x] Use injected RNG or UUID helper already available in repo.
  - [x] Apply to live, paper, and backtest engines.
  - [x] Preserve uniqueness.
  - [x] Test deterministic ids when seeded RNG supplied.

- [x] Replace `Math.random()` in simulation market data.
  - [x] Use injected RNG from deterministic utilities.
  - [x] Preserve existing realistic ranges.
  - [x] Test repeatability.

- [x] Replace random strategy optimizer metrics.
  - [x] Use backtest engine evaluation for parameter scoring.
  - [x] Remove mock metric return path.
  - [x] Keep random search candidate generation seeded.
  - [x] Test same seed returns same best parameters.

- [x] Replace random stress-test strategy generation or seed it.
  - [x] Inject RNG through strategy parameters or context.
  - [x] Preserve random stress behavior when no seed supplied.
  - [x] Test seeded stress strategy emits repeatable signals.

## Phase 10: Paper And Backtest Accuracy

- [x] Fix paper slippage threshold order.
  - [x] Check `$100,000` threshold before `$10,000`.
  - [x] Add test for `$150,000` order using `2.0x` multiplier.
  - [x] Add test for `$50,000` order using `1.5x` multiplier.

- [x] Remove paper fake price fallback.
  - [x] Reject paper order when market manager has no price.
  - [x] Mark order rejected with reason `price_unavailable`.
  - [x] Test unavailable price rejects order.

- [x] Replace paper hardcoded available pairs.
  - [x] Fetch available pairs from `TradingPairService` or `MarketManager`.
  - [x] Keep ETH/USDC, BTC/USDC, and SOL/USDC defaults only in one canonical table.
  - [x] Test configured pair list changes generated market data.

- [x] Improve backtest order cancellation behavior.
  - [x] Keep immediate-fill orders uncancellable.
  - [x] Return explicit status/reason for cancellation request.
  - [x] Test cancelling filled backtest order returns no-op/filled state.

- [x] Replace backtest neutral indicators.
  - [x] Use shared indicator helpers with historical windows.
  - [x] Keep neutral only before enough candle history exists.
  - [x] Test RSI changes after enough data.

## Phase 11: Public API Stubs And Analytics

- [x] Implement or remove `rebalance()`.
  - [x] Compute current allocation from portfolio.
  - [x] Compute target trade deltas from requested target weights.
  - [x] Submit orders through active execution engine.
  - [x] Return executed trades and new allocation from actual order results.
  - [x] Test zero-delta rebalance submits no orders.
  - [x] Test overweight asset creates sell order.
  - [x] Test underweight asset creates buy order.

- [x] Implement `setTakeProfitPercent()`.
  - [x] Store take-profit percent in bot risk/order settings.
  - [x] Apply setting when opening new position if no explicit take-profit exists.
  - [x] Create actionable take-profit trigger using existing trigger mechanism.
  - [x] Test setting persists.
  - [x] Test buy with take-profit setting creates trigger.

- [x] Implement `getRiskHeatmap()`.
  - [x] Build heatmap from current positions, exposure, drawdown, concentration, and correlation risk.
  - [x] Return deterministic display string.
  - [x] Test empty portfolio heatmap.
  - [x] Test concentrated portfolio heatmap.

- [x] Replace placeholder plotting/export methods in backtest results.
  - [x] Implement `exportTrades(filename)` as CSV writer.
  - [x] Implement equity curve data export or return chart data.
  - [x] Implement drawdown data export or return chart data.
  - [x] Test CSV output fields.
  - [x] Test equity curve data non-empty after trades.

## Phase 12: Market Data Mode Separation

- [x] Prevent live realtime fallback to simulation.
  - [x] Add explicit realtime mode: `live`, `simulation`, or `test`.
  - [x] In live mode, throw connection error when SDK WebSocket client is unavailable.
  - [x] In live mode, throw connection error when WebSocket connect times out.
  - [x] In live mode, do not call `startMarketDataSimulation()` from connection failure paths.
  - [x] Keep simulation fallback only for explicit simulation/test mode.
  - [x] Test live mode missing `sdk.ws` rejects connection.
  - [x] Test live mode WebSocket timeout rejects connection.
  - [x] Test simulation mode still starts simulated stream.

- [x] Remove duplicate simulation branch in `RealtimeManager.connect()`.
  - [x] Delete second `if (this.useSimulation)` block.
  - [x] Keep single simulation-mode entry path at start of `connect()`.
  - [x] Test simulation `connect()` calls `startMarketDataSimulation()` once.

- [x] Split `MarketManager` live and simulation data paths.
  - [x] Add explicit market data mode to `MarketManager`.
  - [x] In live mode, require SDK-backed data for price, orderbook, ticker, candles, and recent trades.
  - [x] In simulation mode, allow generated mock price, orderbook, ticker, candles, and recent trades.
  - [x] In live mode, do not generate mock orderbooks when cache is empty.
  - [x] In live mode, do not generate mock candles when candle cache is empty.
  - [x] In live mode, do not generate mock recent trades when trade cache is empty.
  - [x] Test live price SDK failure rejects.
  - [x] Test live orderbook missing data rejects.
  - [x] Test simulation still generates orderbook.
  - [x] Test simulation still generates candles.

- [x] Remove live SDK failure fallback to mock price in `MarketManager.getCurrentPrice()`.
  - [x] Throw typed `MarketDataUnavailableError` when SDK candlestick fetch fails in live mode.
  - [x] Include pair symbol, interval, and original error message in typed error.
  - [x] Keep mock fallback only when manager mode is simulation.
  - [x] Test live SDK fetch error throws typed error.
  - [x] Test simulation unknown valid pair still derives mock price.

- [x] Add live implementations for `MarketManager.getOrderBook()`, `getTicker()`, `getCandles()`, and `getRecentTrades()`.
  - [x] Fetch orderbook from Monaco realtime cache or SDK API when available.
  - [x] Fetch ticker from Monaco market API when available.
  - [x] Fetch candles from Monaco market candlesticks endpoint.
  - [x] Fetch recent trades from Monaco market trades endpoint when SDK supports it.
  - [x] Return typed unavailable errors for unsupported SDK endpoints.
  - [x] Test each live method does not touch mock maps.

## Phase 13: Realtime Event Correctness

- [x] Make realtime simulation deterministic.
  - [x] Inject `Rng` and `Clock` into `RealtimeManager`.
  - [x] Replace direct `Math.random()` in mock trade emission with injected RNG.
  - [x] Replace direct `Date.now()` in mock trade ids/timestamps with injected clock.
  - [x] Preserve existing simulation event frequency using RNG threshold.
  - [x] Test same seed emits same mock trade sequence.

- [x] Replace simulated user order updates with real order lifecycle events.
  - [x] Remove random `Math.random() > 0.95` user order update emission.
  - [x] Subscribe user-order stream to order lifecycle store/event emitter from Phase 5.
  - [x] Emit user order update only when an order actually changes status.
  - [x] Include previous status and new status in event payload.
  - [x] Test no random user order event appears without order change.
  - [x] Test fill event appears on user order stream.
  - [x] Test cancel event appears on user order stream.

- [x] Add realtime mode status APIs.
  - [x] Expose whether realtime manager is using live WebSocket or simulation.
  - [x] Expose last connection error.
  - [x] Expose active subscription keys without exposing callback references.
  - [x] Test live connection status after SDK connect.
  - [x] Test simulation connection status after simulation connect.
  - [x] Test disconnect clears status and active subscriptions.

## Phase 14: Position Accounting Correctness

- [x] Fix sell-side position updates.
  - [x] Always update base-token position for buy and sell fills.
  - [x] On buy, increase base balance and update weighted average entry price.
  - [x] On sell, decrease base balance and compute realized PnL against base average entry price.
  - [x] Do not create quote-token position for sell fills.
  - [x] Test buy creates base position.
  - [x] Test sell reduces base position.
  - [x] Test sell does not create quote position.
  - [x] Test partial sell preserves remaining average entry price.

- [x] Replace hardcoded position fee formula.
  - [x] Pass fee amount from order lifecycle fill when available.
  - [x] Use configured maker/taker fee bps when fill fee is not supplied.
  - [x] Remove `(fillPrice * fillQuantity) / 10000` hardcoded fee calculation.
  - [x] Store fee currency explicitly.
  - [x] Test supplied fill fee is used exactly.
  - [x] Test configured fee bps fallback is used.

- [x] Make initial balances configurable.
  - [x] Add `startingBalances?: Record<Address, bigint>` to `PositionTracker` constructor options.
  - [x] Load mock default balances only in explicit simulation mode.
  - [x] Start with empty balances in live mode unless loaded from profile.
  - [x] Preserve current tests by passing simulation mode/default balances.
  - [x] Test live tracker starts empty.
  - [x] Test simulation tracker loads defaults.
  - [x] Test custom starting balances override defaults.

- [x] Fix portfolio cash/quote valuation.
  - [x] Identify quote/stable balances separately from open positions.
  - [x] Value quote/stable balances using decimals and quote currency rules, not raw balance as USD value.
  - [x] Exclude pure cash balances from `openPositions` count.
  - [x] Include cash in total portfolio value.
  - [x] Test USDC balance contributes cash value.
  - [x] Test cash balance does not count as open position.
  - [x] Test base asset position uses market price.

- [x] Fix daily PnL calculation.
  - [x] Calculate daily realized PnL from closed sell fills, not gross sell proceeds.
  - [x] Add daily unrealized PnL change when enough mark data exists.
  - [x] Subtract fees from daily PnL.
  - [x] Test profitable sell adds realized profit only.
  - [x] Test losing sell subtracts realized loss.
  - [x] Test buy-only day does not create positive daily PnL.

- [x] Fix performance metrics that compare sell price to current position average after sells.
  - [x] Store realized PnL per sell fill in trade history.
  - [x] Compute win/loss from stored realized PnL.
  - [x] Compute profit factor from realized wins and realized losses.
  - [x] Compute Sharpe from realized returns or equity curve, not current average price.
  - [x] Test win rate from two winning and one losing realized trades.
  - [x] Test profit factor from realized PnL.

## Phase 15: Config Unification

- [x] Make one source of truth for TOML schema.
  - [x] Remove duplicated inline schema object from `packages/mach1_bot/src/cli/utils/config-schema.ts`.
  - [x] Load `packages/mach1_bot/schema/toml-config.schema.json` as canonical schema.
  - [x] Export schema type from loaded JSON or generated TypeScript type.
  - [x] Add script or test that fails when TypeScript schema and JSON schema drift.
  - [x] Test `loadTomlConfigSchema()` returns canonical JSON schema.

- [x] Align config mode names.
  - [x] Use runtime mode union consistently: `backtest`, `simulation`, `live`.
  - [x] Treat `paper` only as accepted input alias.
  - [x] Normalize `paper` to `simulation` at config boundary.
  - [x] Remove `"paper"` from internal default config.
  - [x] Test `paper` input becomes `simulation`.
  - [x] Test exported sanitized config uses `simulation`.

- [x] Relax private-key and RPC requirements for non-live modes.
  - [x] Require private key only for live mode or commands that submit live transactions.
  - [x] Require RPC URL only for live mode and wallet-chain commands.
  - [x] Allow backtest config without private key.
  - [x] Allow simulation config without private key.
  - [x] Test backtest config loads without private key.
  - [x] Test simulation config loads without private key.
  - [x] Test live config still rejects missing private key.
  - [x] Test live config still rejects invalid RPC URL.

- [x] Remove unused duplicated default config helper.
  - [x] Delete `getDefaultConfig()` if no caller uses it.
  - [x] Keep a single `defaults` object or exported factory.
  - [x] Test default values still applied by `loadConfig()`.

- [x] Prevent unsafe config file writes.
  - [x] Make `saveToFile()` exclude sensitive values by default.
  - [x] Add explicit option to include secrets when caller intentionally requests it.
  - [x] Ensure CLI never writes raw private key unless command explicitly says so.
  - [x] Test default save redacts private key.
  - [x] Test explicit include-secrets path writes full config.

## Phase 16: Regression Test Matrix

- [x] Add end-to-end strategy execution tests.
  - [x] Test strategy tick receives real non-placeholder market data.
  - [x] Test valid buy signal becomes risk check then order submission.
  - [x] Test risk rejection prevents order submission.
  - [x] Test filled order updates position tracker.
  - [x] Test filled order updates strategy performance.
  - [x] Test rejected order does not update position or performance.

- [x] Add live safety tests.
  - [x] Test missing live market data skips strategy tick.
  - [x] Test missing live price rejects manual buy/sell.
  - [x] Test Monaco auth pause blocks order placement.
  - [x] Test pre-trade insufficient funds returns rejected order.

- [x] Add cleanup tests.
  - [x] Test `emergencyStop()` stops coordinator.
  - [x] Test `emergencyStop()` cancels pending orders.
  - [x] Test `goLive()` active interval count does not grow after stop/start cycle.
  - [x] Test strategy stop cleans market subscriptions.

- [x] Add typecheck/lint guard.
  - [x] Ensure `npm run typecheck` passes.
  - [x] Run targeted Vitest suites:
    - [x] `packages/mach1_bot/tests/unit/bot/mach1-bot.test.ts`
    - [x] `packages/mach1_bot/tests/unit/execution/live-trading-engine.test.ts`
    - [x] `packages/mach1_bot/tests/unit/core/risk-manager.test.ts`
    - [x] `packages/mach1_bot/tests/unit/core/order-manager.test.ts`
    - [x] `packages/mach1_bot/tests/unit/core/market-manager.test.ts`
    - [x] `packages/mach1_bot/tests/unit/trading/position-tracker-order-events.test.ts`
    - [x] `packages/mach1_bot/tests/unit/config/config-manager.test.ts`
    - [x] Strategy manager tests added for this roadmap.

## Phase 17: Monaco Perps Contract Discovery

- [x] Confirm Monaco isolated-margin and perps contract surface before bot integration.
  - [x] Inspect `@0xmonaco/core` methods behind `MarginAccountsAPIImpl`, `PositionsAPIImpl`, and perp routes.
  - [x] Document which methods support isolated margin account lookup, margin balances, open positions, order placement, order cancellation, and order close/reduce flows.
  - [x] Reject guessed request or response shapes; use real Monaco types only.
  - [x] Keep scope limited to isolated margin. Do not add cross-margin support.
  - [x] Add notes in code comments only where Monaco behavior is non-obvious.

- [x] Lock bot-facing requirements against confirmed Monaco contracts.
  - [x] Match isolated account, balance, position, and order flows to existing `mach1_bot` execution and risk abstractions.
  - [x] Identify Monaco gaps that require SDK normalization before bot integration.
  - [x] Reject direct `mach1_bot` usage of opaque Monaco route objects.
  - [x] Preserve isolated-margin-only scope for this roadmap.

## Phase 18: Typed SDK Perps Surface

- [x] Add stable typed perps access through `mach1_sdk`.
  - [x] Extend `packages/mach1_sdk/src/sdk.ts` with typed helpers or typed facades for isolated margin accounts, margin balances, positions, and perp order routes.
  - [x] Keep auth and access-token propagation working for new helpers.
  - [x] Prefer wrapping Monaco route objects over leaking raw route usage into `mach1_bot`.
  - [x] Preserve existing SDK public API behavior for spot consumers.
  - [x] Run `npm --prefix packages/mach1_sdk run typecheck`.

- [x] Add SDK coverage for isolated margin and perps paths.
  - [x] Test typed isolated margin account lookup.
  - [x] Test typed margin balance retrieval.
  - [x] Test typed open position retrieval.
  - [x] Test perp order request normalization when Monaco types require adaptation.
  - [x] Keep existing spot tests passing.

## Phase 19: Perps Market Discovery And Config Surface

- [x] Allow market discovery to select perp-capable markets.
  - [x] Replace `SPOT`-only filtering in `packages/mach1_bot/src/domains/trading/market-manager.ts` with explicit market-type filtering.
  - [x] Support spot behavior and isolated perps behavior without implicit fallback between them.
  - [x] Reject unsupported market types instead of silently downgrading to spot.
  - [x] Test spot-only selection.
  - [x] Test isolated-perps selection.
  - [x] Test unsupported market-type rejection.

- [x] Extend shared bot types for isolated perps live trading.
  - [x] Add explicit live trading market mode to shared config and execution types.
  - [x] Extend order types with perps fields: direction, leverage, reduce-only, and close-only semantics when needed.
  - [x] Extend position types with collateral, maintenance margin, liquidation price, side, and funding fields.
  - [x] Keep shared type additions optional where spot code still compiles unchanged.
  - [x] Run `npm --prefix packages/mach1_bot run typecheck`.

- [x] Add isolated-perps TOML config support.
  - [x] Extend canonical schema in `packages/mach1_bot/schema/toml-config.schema.json`.
  - [x] Add isolated margin config fields for live perps mode.
  - [x] Validate leverage and liquidation-threshold settings at config boundary.
  - [x] Reject cross-margin config values for this phase.
  - [x] Test config load accepts isolated perps mode.
  - [x] Test config load rejects unsupported perps settings.

## Phase 20: Isolated Perps Execution Engine And State Sync

- [x] Add dedicated isolated-perps live execution engine.
  - [x] Create perps engine beside current spot `LiveTradingEngine` instead of branching spot logic through one class.
  - [x] Reuse shared execution-engine contract and trading-mode abstractions.
  - [x] Keep spot live engine behavior unchanged.
  - [x] Test perps engine type-level compliance with shared execution interface.

- [x] Load isolated margin state before and during live trading.
  - [x] Fetch isolated margin account state on engine initialize.
  - [x] Fetch free collateral, used margin, maintenance margin, and open positions on sync cycle.
  - [x] Fail closed when isolated account state cannot be loaded in live perps mode.
  - [x] Test initialize rejects when margin account fetch fails.
  - [x] Test sync updates cached isolated margin state.

- [x] Add perp order placement and close flows.
  - [x] Support long and short position entry through Monaco perps route.
  - [x] Support reduce-only or close-position order path when Monaco supports it.
  - [x] Preserve order lifecycle tracking through existing order store and event emitter.
  - [x] Keep retry logic only for retryable transport or rate-limit failures.
  - [x] Test long order submission path.
  - [x] Test short order submission path.
  - [x] Test reduce-only close path.

- [x] Track isolated perps positions and PnL.
  - [x] Extend `PositionTracker` or add dedicated perps tracker for side-aware positions.
  - [x] Track entry price, mark price, collateral, leverage, realized PnL, unrealized PnL, and fees.
  - [x] Add liquidation price and maintenance-margin state to tracked positions.
  - [x] Keep fill-based accounting rules from earlier phases.
  - [x] Test long PnL updates from mark price.
  - [x] Test short PnL updates from mark price.
  - [x] Test partial close preserves remaining average entry price.

## Phase 21: Isolated Perps Risk, Funding, And Liquidation Safety

- [x] Extend risk manager for isolated perps.
  - [x] Enforce configured max leverage before order submission.
  - [x] Enforce free-collateral sufficiency before order submission.
  - [x] Enforce max per-position risk and per-market exposure.
  - [x] Preserve existing spot risk checks without changing their pass/fail behavior.
  - [x] Test leverage rejection.
  - [x] Test insufficient collateral rejection.
  - [x] Test spot path unchanged.

- [x] Add liquidation-distance checks.
  - [x] Compute liquidation distance from mark price and maintenance margin.
  - [x] Reject new risk-increasing orders when liquidation distance is below configured threshold.
  - [x] Emit warning or critical risk events when open position approaches liquidation.
  - [x] Keep fail-closed behavior when mark price or maintenance-margin inputs are stale.
  - [x] Test warning threshold.
  - [x] Test critical threshold.
  - [x] Test stale mark data blocks approval.

- [x] Add funding-rate handling.
  - [x] Load funding rate from Monaco when supported.
  - [x] Add polling fallback only when no streaming path exists.
  - [x] Track accrued funding on open positions.
  - [x] Reflect funding in unrealized or realized PnL consistently.
  - [x] Test funding update changes tracked position state.
  - [x] Test missing funding data creates fail-closed warning or skip behavior.

- [x] Add liquidation and auto-pause hooks.
  - [x] Emit typed events for margin warning, liquidation warning, and liquidation-triggered state.
  - [x] Wire live-trading pause callback for critical liquidation-risk events.
  - [x] Do not auto-resume after liquidation-risk pause without explicit operator action.
  - [x] Test critical liquidation event pauses live trading.

## Phase 22: Strategy, CLI, And Operator Workflow For Perps

- [x] Allow strategies to emit perps-capable signals.
  - [x] Extend strategy signal validation for long, short, and reduce-only semantics where required.
  - [x] Keep unsupported advanced order actions rejected until engine support exists.
  - [x] Preserve coordinator tick loop and existing strategy scheduling behavior.
  - [x] Test valid long signal becomes perps order request.
  - [x] Test reduce-only signal skips unsupported path when fields missing.

- [x] Extend CLI live commands for isolated perps visibility.
  - [x] Add commands or output paths to show isolated margin balances.
  - [x] Add commands or output paths to show open perps positions.
  - [x] Show leverage, collateral, unrealized PnL, funding, and liquidation price in live inspection views.
  - [x] Keep spot command behavior unchanged.
  - [x] Test CLI formatting for empty isolated account state.
  - [x] Test CLI formatting for active perps position state.

- [x] Add isolated-perps example configs and docs.
  - [x] Add one live isolated-perps TOML example under `packages/mach1_bot/example_configs/`.
  - [x] Document required config fields and supported order behaviors.
  - [x] Document that this roadmap supports isolated margin only.
  - [x] Document fail-closed behavior for stale mark price, stale funding data, and missing margin account state.

## Phase 23: Perps Regression Matrix And Release Guard

- [x] Add isolated-perps regression tests.
  - [x] Test market discovery returns perp-capable market when configured.
  - [x] Test isolated margin state sync seeds engine and tracker state.
  - [x] Test long entry then reduce-only close updates lifecycle and PnL.
  - [x] Test short entry then close updates lifecycle and PnL.
  - [x] Test liquidation-risk warning event reaches strategy or supervisor path.
  - [x] Test funding update changes tracked account state.

- [x] Add focused live safety tests for perps.
  - [x] Test missing isolated margin account rejects live perps start.
  - [x] Test stale mark price blocks new perps order.
  - [x] Test insufficient collateral rejects before Monaco order call.
  - [x] Test liquidation-risk pause blocks later order placement.

- [x] Add final verification guard for isolated perps work.
  - [x] Ensure `npm --prefix packages/mach1_sdk run typecheck` passes.
  - [x] Ensure `npm --prefix packages/mach1_bot run typecheck` passes.
  - [x] Run targeted Vitest files for touched perps areas.
  - [x] Run `npm run typecheck` from repo root before checking off final item.
  - [x] Keep spot regression suites green before merge.

## Phase 24: Execution Findings And Strategy Gaps

- [x] Unify live spot order units with shared execution contract.
  - [x] Remove mixed use of cents-scaled bot units and token-decimal base units across `Mach1Bot`, `StrategyManager`, and `LiveTradingEngine`.
  - [x] Keep one explicit internal contract for `OrderRequest.price` and `OrderRequest.quantity`, or add conversion boundary helpers where live spot requires token-decimal units.
  - [x] Re-audit live balance checks, slippage estimation, quote notional math, and fill accounting after unit fix.
  - [x] Add regression tests proving live spot buy/sell, slippage, and risk notional stay correct for assets with non-2-decimal token precision.

- [x] Fix strategy exit sizing for builtin and example strategies.
  - [x] Update strategies that emit `sell` without `quantity`, including `multi_indicator_v1`, RSI example, MA crossover example, and pairs-trading exit paths.
  - [x] Decide one canonical exit behavior: explicit quantity from strategy, full-position close helper, or reduce-only/close action semantics.
  - [x] Keep signal validation fail-closed when neither explicit quantity nor valid close semantics exist.
  - [x] Add tests proving exit signals place orders instead of being skipped by validation.

- [x] Scope backtest data loading to configured strategy pairs.
  - [x] Pass configured trading pairs into `BacktestEngine.filterDataFiles()` instead of filtering only by date range.
  - [x] Prevent unrelated CSV files in `backtest-data` from being loaded for single-pair runs such as `SOL/USDC`.
  - [x] Keep multi-pair backtests working when config intentionally requests multiple markets.
  - [x] Add tests proving single-pair backtests ignore unrelated BTC/ETH datasets.

- [x] Align simulation market data with configured pair universe.
  - [x] Stop hardcoding simulation output to `ETH/USDC` and `BTC/USDC` only.
  - [x] Feed preferred or configured trading pairs into `MarketDataService.buildSimulationMarketData()`.
  - [x] Preserve canonical fallback symbol table in one place only.
  - [x] Add tests proving `SOL/USDC` strategies receive simulation ticks without custom patching.

- [x] Harden strategy execution against overtrading and stale exposure state.
  - [x] Add position-aware sizing helpers so strategies can size entries and exits from current holdings, pending orders, and available capital.
  - [x] Add cooldown or duplicate-signal suppression so repeated ticks do not stack identical orders in choppy markets.
  - [x] Expose reusable helpers for full-close, partial-close, and max-risk-per-trade sizing.
  - [x] Add tests for repeated confluence signals, pending-order overlap, and position-aware exit behavior.

- [x] Strengthen `multi_indicator_v1` beyond raw confluence count.
  - [x] Add trend or regime filter so mean-reversion entries do not fire blindly in strong directional moves.
  - [x] Add spread, liquidity, or volatility guardrails before signal execution.
  - [x] Add warmup-quality checks based on candle count and indicator stability, not only minimum sample count.
  - [x] Add backtest coverage for trend regime, low-liquidity skip, and high-volatility skip behavior.
