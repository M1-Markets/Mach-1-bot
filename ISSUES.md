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

- [ ] Implement or remove `rebalance()`.
  - [ ] Compute current allocation from portfolio.
  - [ ] Compute target trade deltas from requested target weights.
  - [ ] Submit orders through active execution engine.
  - [ ] Return executed trades and new allocation from actual order results.
  - [ ] Test zero-delta rebalance submits no orders.
  - [ ] Test overweight asset creates sell order.
  - [ ] Test underweight asset creates buy order.

- [ ] Implement `setTakeProfitPercent()`.
  - [ ] Store take-profit percent in bot risk/order settings.
  - [ ] Apply setting when opening new position if no explicit take-profit exists.
  - [ ] Create actionable take-profit trigger using existing trigger mechanism.
  - [ ] Test setting persists.
  - [ ] Test buy with take-profit setting creates trigger.

- [ ] Implement `getRiskHeatmap()`.
  - [ ] Build heatmap from current positions, exposure, drawdown, concentration, and correlation risk.
  - [ ] Return deterministic display string.
  - [ ] Test empty portfolio heatmap.
  - [ ] Test concentrated portfolio heatmap.

- [ ] Replace placeholder plotting/export methods in backtest results.
  - [ ] Implement `exportTrades(filename)` as CSV writer.
  - [ ] Implement equity curve data export or return chart data.
  - [ ] Implement drawdown data export or return chart data.
  - [ ] Test CSV output fields.
  - [ ] Test equity curve data non-empty after trades.

## Phase 12: Market Data Mode Separation

- [ ] Prevent live realtime fallback to simulation.
  - [ ] Add explicit realtime mode: `live`, `simulation`, or `test`.
  - [ ] In live mode, throw connection error when SDK WebSocket client is unavailable.
  - [ ] In live mode, throw connection error when WebSocket connect times out.
  - [ ] In live mode, do not call `startMarketDataSimulation()` from connection failure paths.
  - [ ] Keep simulation fallback only for explicit simulation/test mode.
  - [ ] Test live mode missing `sdk.ws` rejects connection.
  - [ ] Test live mode WebSocket timeout rejects connection.
  - [ ] Test simulation mode still starts simulated stream.

- [ ] Remove duplicate simulation branch in `RealtimeManager.connect()`.
  - [ ] Delete second `if (this.useSimulation)` block.
  - [ ] Keep single simulation-mode entry path at start of `connect()`.
  - [ ] Test simulation `connect()` calls `startMarketDataSimulation()` once.

- [ ] Split `MarketManager` live and simulation data paths.
  - [ ] Add explicit market data mode to `MarketManager`.
  - [ ] In live mode, require SDK-backed data for price, orderbook, ticker, candles, and recent trades.
  - [ ] In simulation mode, allow generated mock price, orderbook, ticker, candles, and recent trades.
  - [ ] In live mode, do not generate mock orderbooks when cache is empty.
  - [ ] In live mode, do not generate mock candles when candle cache is empty.
  - [ ] In live mode, do not generate mock recent trades when trade cache is empty.
  - [ ] Test live price SDK failure rejects.
  - [ ] Test live orderbook missing data rejects.
  - [ ] Test simulation still generates orderbook.
  - [ ] Test simulation still generates candles.

- [ ] Remove live SDK failure fallback to mock price in `MarketManager.getCurrentPrice()`.
  - [ ] Throw typed `MarketDataUnavailableError` when SDK candlestick fetch fails in live mode.
  - [ ] Include pair symbol, interval, and original error message in typed error.
  - [ ] Keep mock fallback only when manager mode is simulation.
  - [ ] Test live SDK fetch error throws typed error.
  - [ ] Test simulation unknown valid pair still derives mock price.

- [ ] Add live implementations for `MarketManager.getOrderBook()`, `getTicker()`, `getCandles()`, and `getRecentTrades()`.
  - [ ] Fetch orderbook from Monaco realtime cache or SDK API when available.
  - [ ] Fetch ticker from Monaco market API when available.
  - [ ] Fetch candles from Monaco market candlesticks endpoint.
  - [ ] Fetch recent trades from Monaco market trades endpoint when SDK supports it.
  - [ ] Return typed unavailable errors for unsupported SDK endpoints.
  - [ ] Test each live method does not touch mock maps.

## Phase 13: Realtime Event Correctness

- [ ] Make realtime simulation deterministic.
  - [ ] Inject `Rng` and `Clock` into `RealtimeManager`.
  - [ ] Replace direct `Math.random()` in mock trade emission with injected RNG.
  - [ ] Replace direct `Date.now()` in mock trade ids/timestamps with injected clock.
  - [ ] Preserve existing simulation event frequency using RNG threshold.
  - [ ] Test same seed emits same mock trade sequence.

- [ ] Replace simulated user order updates with real order lifecycle events.
  - [ ] Remove random `Math.random() > 0.95` user order update emission.
  - [ ] Subscribe user-order stream to order lifecycle store/event emitter from Phase 5.
  - [ ] Emit user order update only when an order actually changes status.
  - [ ] Include previous status and new status in event payload.
  - [ ] Test no random user order event appears without order change.
  - [ ] Test fill event appears on user order stream.
  - [ ] Test cancel event appears on user order stream.

- [ ] Add realtime mode status APIs.
  - [ ] Expose whether realtime manager is using live WebSocket or simulation.
  - [ ] Expose last connection error.
  - [ ] Expose active subscription keys without exposing callback references.
  - [ ] Test live connection status after SDK connect.
  - [ ] Test simulation connection status after simulation connect.
  - [ ] Test disconnect clears status and active subscriptions.

## Phase 14: Position Accounting Correctness

- [ ] Fix sell-side position updates.
  - [ ] Always update base-token position for buy and sell fills.
  - [ ] On buy, increase base balance and update weighted average entry price.
  - [ ] On sell, decrease base balance and compute realized PnL against base average entry price.
  - [ ] Do not create quote-token position for sell fills.
  - [ ] Test buy creates base position.
  - [ ] Test sell reduces base position.
  - [ ] Test sell does not create quote position.
  - [ ] Test partial sell preserves remaining average entry price.

- [ ] Replace hardcoded position fee formula.
  - [ ] Pass fee amount from order lifecycle fill when available.
  - [ ] Use configured maker/taker fee bps when fill fee is not supplied.
  - [ ] Remove `(fillPrice * fillQuantity) / 10000` hardcoded fee calculation.
  - [ ] Store fee currency explicitly.
  - [ ] Test supplied fill fee is used exactly.
  - [ ] Test configured fee bps fallback is used.

- [ ] Make initial balances configurable.
  - [ ] Add `startingBalances?: Record<Address, bigint>` to `PositionTracker` constructor options.
  - [ ] Load mock default balances only in explicit simulation mode.
  - [ ] Start with empty balances in live mode unless loaded from profile.
  - [ ] Preserve current tests by passing simulation mode/default balances.
  - [ ] Test live tracker starts empty.
  - [ ] Test simulation tracker loads defaults.
  - [ ] Test custom starting balances override defaults.

- [ ] Fix portfolio cash/quote valuation.
  - [ ] Identify quote/stable balances separately from open positions.
  - [ ] Value quote/stable balances using decimals and quote currency rules, not raw balance as USD value.
  - [ ] Exclude pure cash balances from `openPositions` count.
  - [ ] Include cash in total portfolio value.
  - [ ] Test USDC balance contributes cash value.
  - [ ] Test cash balance does not count as open position.
  - [ ] Test base asset position uses market price.

- [ ] Fix daily PnL calculation.
  - [ ] Calculate daily realized PnL from closed sell fills, not gross sell proceeds.
  - [ ] Add daily unrealized PnL change when enough mark data exists.
  - [ ] Subtract fees from daily PnL.
  - [ ] Test profitable sell adds realized profit only.
  - [ ] Test losing sell subtracts realized loss.
  - [ ] Test buy-only day does not create positive daily PnL.

- [ ] Fix performance metrics that compare sell price to current position average after sells.
  - [ ] Store realized PnL per sell fill in trade history.
  - [ ] Compute win/loss from stored realized PnL.
  - [ ] Compute profit factor from realized wins and realized losses.
  - [ ] Compute Sharpe from realized returns or equity curve, not current average price.
  - [ ] Test win rate from two winning and one losing realized trades.
  - [ ] Test profit factor from realized PnL.

## Phase 15: Config Unification

- [ ] Make one source of truth for TOML schema.
  - [ ] Remove duplicated inline schema object from `packages/mach1_bot/src/cli/utils/config-schema.ts`.
  - [ ] Load `packages/mach1_bot/schema/toml-config.schema.json` as canonical schema.
  - [ ] Export schema type from loaded JSON or generated TypeScript type.
  - [ ] Add script or test that fails when TypeScript schema and JSON schema drift.
  - [ ] Test `loadTomlConfigSchema()` returns canonical JSON schema.

- [ ] Align config mode names.
  - [ ] Use runtime mode union consistently: `backtest`, `simulation`, `live`.
  - [ ] Treat `paper` only as accepted input alias.
  - [ ] Normalize `paper` to `simulation` at config boundary.
  - [ ] Remove `"paper"` from internal default config.
  - [ ] Test `paper` input becomes `simulation`.
  - [ ] Test exported sanitized config uses `simulation`.

- [ ] Relax private-key and RPC requirements for non-live modes.
  - [ ] Require private key only for live mode or commands that submit live transactions.
  - [ ] Require RPC URL only for live mode and wallet-chain commands.
  - [ ] Allow backtest config without private key.
  - [ ] Allow simulation config without private key.
  - [ ] Test backtest config loads without private key.
  - [ ] Test simulation config loads without private key.
  - [ ] Test live config still rejects missing private key.
  - [ ] Test live config still rejects invalid RPC URL.

- [ ] Remove unused duplicated default config helper.
  - [ ] Delete `getDefaultConfig()` if no caller uses it.
  - [ ] Keep a single `defaults` object or exported factory.
  - [ ] Test default values still applied by `loadConfig()`.

- [ ] Prevent unsafe config file writes.
  - [ ] Make `saveToFile()` exclude sensitive values by default.
  - [ ] Add explicit option to include secrets when caller intentionally requests it.
  - [ ] Ensure CLI never writes raw private key unless command explicitly says so.
  - [ ] Test default save redacts private key.
  - [ ] Test explicit include-secrets path writes full config.

## Phase 16: Regression Test Matrix

- [ ] Add end-to-end strategy execution tests.
  - [ ] Test strategy tick receives real non-placeholder market data.
  - [ ] Test valid buy signal becomes risk check then order submission.
  - [ ] Test risk rejection prevents order submission.
  - [ ] Test filled order updates position tracker.
  - [ ] Test filled order updates strategy performance.
  - [ ] Test rejected order does not update position or performance.

- [ ] Add live safety tests.
  - [ ] Test missing live market data skips strategy tick.
  - [ ] Test missing live price rejects manual buy/sell.
  - [ ] Test Monaco auth pause blocks order placement.
  - [ ] Test pre-trade insufficient funds returns rejected order.

- [ ] Add cleanup tests.
  - [ ] Test `emergencyStop()` stops coordinator.
  - [ ] Test `emergencyStop()` cancels pending orders.
  - [ ] Test `goLive()` active interval count does not grow after stop/start cycle.
  - [ ] Test strategy stop cleans market subscriptions.

- [ ] Add typecheck/lint guard.
  - [ ] Ensure `npm run typecheck` passes.
  - [ ] Run targeted Vitest suites:
    - [ ] `packages/mach1_bot/tests/unit/bot/mach1-bot.test.ts`
    - [ ] `packages/mach1_bot/tests/unit/execution/live-trading-engine.test.ts`
    - [ ] `packages/mach1_bot/tests/unit/core/risk-manager.test.ts`
    - [ ] `packages/mach1_bot/tests/unit/core/order-manager.test.ts`
    - [ ] `packages/mach1_bot/tests/unit/core/market-manager.test.ts`
    - [ ] `packages/mach1_bot/tests/unit/core/position-tracker.test.ts`
    - [ ] `packages/mach1_bot/tests/unit/config/config-manager.test.ts`
    - [ ] Strategy manager tests added for this roadmap.
