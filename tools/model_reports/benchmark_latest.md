# Pre-game win-prob benchmark (walk-forward)
generated 2026-09-26 02:52, test seasons [37, 39, 41, 43, 45, 47], Elo {'K': 10, 'hfa': 40, 'carry': 0.4}

| config | acc | logloss | brier | AUC | ECE | dLL vs incumbent [95% CI] | seasons better |
|---|---|---|---|---|---|---|---|
| RF base (incumbent) | 0.614 | 0.6535 | 0.2307 | 0.659 | 0.026 | - | - |
| AVG[RF +elo+sched+avail | LR diff +elo+sched+avail] | 0.631 | 0.6452 | 0.2266 | 0.672 | 0.029 | -0.0084 [-0.0141, -0.0020] | 5/6 |
| AVG[RF +elo+avail | LR diff +elo+avail] | 0.635 | 0.6456 | 0.2268 | 0.671 | 0.029 | -0.0079 [-0.0136, -0.0018] | 5/6 |
| LR diff +all C=0.003 | 0.636 | 0.6464 | 0.2269 | 0.672 | 0.028 | -0.0072 [-0.0149, +0.0010] | 5/6 |
| LR diff +elo+avail | 0.636 | 0.6464 | 0.2269 | 0.672 | 0.030 | -0.0071 [-0.0157, +0.0018] | 3/6 |
| LR diff +elo+sched+avail | 0.632 | 0.6474 | 0.2274 | 0.670 | 0.036 | -0.0061 [-0.0147, +0.0029] | 4/6 |
| LR diff +elo | 0.629 | 0.6479 | 0.2278 | 0.671 | 0.029 | -0.0057 [-0.0117, +0.0003] | 5/6 |
| LR diff base | 0.619 | 0.6482 | 0.2280 | 0.669 | 0.032 | -0.0053 [-0.0106, +0.0001] | 6/6 |
| LR diff +all C=0.03 | 0.630 | 0.6482 | 0.2277 | 0.669 | 0.036 | -0.0053 [-0.0143, +0.0042] | 3/6 |
| RF leaf60 +all | 0.626 | 0.6483 | 0.2282 | 0.667 | 0.040 | -0.0052 [-0.0091, -0.0011] | 4/6 |
| RF +elo+sched+avail | 0.626 | 0.6484 | 0.2282 | 0.667 | 0.019 | -0.0051 [-0.0093, -0.0007] | 4/6 |
| LR base | 0.625 | 0.6486 | 0.2282 | 0.669 | 0.026 | -0.0049 [-0.0106, +0.0010] | 5/6 |
| RF +avail | 0.627 | 0.6492 | 0.2286 | 0.667 | 0.026 | -0.0043 [-0.0068, -0.0017] | 5/6 |
| AVG[RF base (incumbent) | LR diff base] | 0.622 | 0.6492 | 0.2286 | 0.667 | 0.031 | -0.0043 [-0.0068, -0.0016] | 6/6 |
| RF +elo+avail | 0.625 | 0.6502 | 0.2290 | 0.663 | 0.030 | -0.0033 [-0.0077, +0.0012] | 3/6 |
| RF +elo | 0.624 | 0.6515 | 0.2296 | 0.662 | 0.022 | -0.0020 [-0.0058, +0.0019] | 3/6 |
| LR elo-only | 0.629 | 0.6522 | 0.2300 | 0.660 | 0.026 | -0.0013 [-0.0083, +0.0054] | 3/6 |
| RF +sched | 0.622 | 0.6531 | 0.2305 | 0.659 | 0.025 | -0.0004 [-0.0023, +0.0015] | 4/6 |
| const home-rate | 0.543 | 0.6897 | 0.2483 | 0.494 | 0.009 | +0.0362 [+0.0247, +0.0473] | 0/6 |
| RF base (incumbent) +isotonic | 0.624 | 0.6561 | 0.2316 | 0.652 | 0.028 | +0.0026 [-0.0007, +0.0059] | 1/6 |
| RF base (incumbent) +platt | 0.611 | 0.6537 | 0.2307 | 0.658 | 0.026 | +0.0002 [-0.0014, +0.0019] | 3/6 |
| AVG[RF +elo+sched+avail | LR diff +elo+sched+avail] +isotonic | 0.639 | 0.6467 | 0.2272 | 0.667 | 0.029 | -0.0069 [-0.0147, +0.0008] | 5/6 |
| AVG[RF +elo+sched+avail | LR diff +elo+sched+avail] +platt | 0.632 | 0.6460 | 0.2269 | 0.672 | 0.028 | -0.0075 [-0.0142, -0.0005] | 5/6 |

Per-season logloss:

- RF base (incumbent): 37:0.672, 39:0.632, 41:0.671, 43:0.628, 45:0.643, 47:0.675
- AVG[RF +elo+sched+avail | LR diff +elo+sched+avail]: 37:0.673, 39:0.628, 41:0.646, 43:0.621, 45:0.636, 47:0.665
- AVG[RF +elo+avail | LR diff +elo+avail]: 37:0.675, 39:0.630, 41:0.646, 43:0.621, 45:0.635, 47:0.666
- LR diff +all C=0.003: 37:0.672, 39:0.628, 41:0.645, 43:0.618, 45:0.639, 47:0.676
- LR diff +elo+avail: 37:0.672, 39:0.632, 41:0.640, 43:0.618, 45:0.639, 47:0.677
- LR diff +elo+sched+avail: 37:0.675, 39:0.631, 41:0.643, 43:0.619, 45:0.639, 47:0.677
- LR diff +elo: 37:0.681, 39:0.625, 41:0.645, 43:0.626, 45:0.641, 47:0.667
- LR diff base: 37:0.671, 39:0.623, 41:0.658, 43:0.620, 45:0.642, 47:0.674
- LR diff +all C=0.03: 37:0.677, 39:0.633, 41:0.643, 43:0.620, 45:0.640, 47:0.677
- RF leaf60 +all: 37:0.678, 39:0.632, 41:0.653, 43:0.626, 45:0.638, 47:0.662
- RF +elo+sched+avail: 37:0.677, 39:0.631, 41:0.654, 43:0.629, 45:0.638, 47:0.661
- LR base: 37:0.679, 39:0.624, 41:0.661, 43:0.623, 45:0.636, 47:0.668
- RF +avail: 37:0.668, 39:0.632, 41:0.667, 43:0.620, 45:0.638, 47:0.670
- AVG[RF base (incumbent) | LR diff base]: 37:0.670, 39:0.626, 41:0.663, 43:0.621, 45:0.641, 47:0.673
- RF +elo+avail: 37:0.683, 39:0.634, 41:0.657, 43:0.629, 45:0.636, 47:0.663
- RF +elo: 37:0.684, 39:0.633, 41:0.660, 43:0.630, 45:0.637, 47:0.664
- LR elo-only: 37:0.692, 39:0.630, 41:0.641, 43:0.638, 45:0.646, 47:0.666
- RF +sched: 37:0.672, 39:0.635, 41:0.673, 43:0.626, 45:0.640, 47:0.672
- const home-rate: 37:0.692, 39:0.687, 41:0.692, 43:0.686, 45:0.691, 47:0.691
- RF base (incumbent) +isotonic: 37:0.677, 39:0.626, 41:0.680, 43:0.629, 45:0.646, 47:0.677
- RF base (incumbent) +platt: 37:0.675, 39:0.629, 41:0.673, 43:0.626, 45:0.642, 47:0.678
- AVG[RF +elo+sched+avail | LR diff +elo+sched+avail] +isotonic: 37:0.676, 39:0.628, 41:0.648, 43:0.622, 45:0.638, 47:0.668
- AVG[RF +elo+sched+avail | LR diff +elo+sched+avail] +platt: 37:0.677, 39:0.627, 41:0.647, 43:0.621, 45:0.636, 47:0.667

Keep rule (pooled logloss better AND >=3 seasons better): {"AVG[RF +elo+sched+avail | LR diff +elo+sched+avail]": true, "AVG[RF +elo+avail | LR diff +elo+avail]": true, "LR diff +all C=0.003": true, "LR diff +elo+avail": true, "LR diff +elo+sched+avail": true, "LR diff +elo": true, "LR diff base": true, "LR diff +all C=0.03": true, "RF leaf60 +all": true, "RF +elo+sched+avail": true, "LR base": true, "RF +avail": true, "AVG[RF base (incumbent) | LR diff base]": true, "RF +elo+avail": true, "RF +elo": true, "LR elo-only": true, "RF +sched": true, "const home-rate": false, "RF base (incumbent) +isotonic": false, "RF base (incumbent) +platt": false, "AVG[RF +elo+sched+avail | LR diff +elo+sched+avail] +isotonic": true, "AVG[RF +elo+sched+avail | LR diff +elo+sched+avail] +platt": true}

Sequential (retrain every 45 games) RF base (incumbent): seq 0.6606 vs static 0.6591, dLL +0.0015 CI [-0.0015195436171818219, 0.0045094795517809025]

Sequential (retrain every 45 games) AVG[RF +elo+sched+avail | LR diff +elo+sched+avail]: seq 0.6508 vs static 0.6507, dLL +0.0001 CI [-0.001804414275417953, 0.0019542147867161906]