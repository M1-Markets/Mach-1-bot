#!/usr/bin/env bash

mkdir -p backtest-data/daily
curl -sSLO https://data.binance.vision/data/spot/daily/trades/SOLUSDC/SOLUSDC-trades-2024-07-01.zip && unzip -oqd backtest-data/daily SOLUSDC-trades-2024-07-01.zip
rm -rf SOLUSDC-trades-2024-07-01.zip
