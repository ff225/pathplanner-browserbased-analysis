#!/usr/bin/env python3
"""
Browser benchmark: real PathPlanner UI stack (Mapbox + routePlanner.js + scores.js).

Uses Playwright with page.evaluate() on window.PathPlannerBenchmark.runPair() —
no fragile DOM clicking; one browser session reused for all grid OD pairs.

Requires:
  pip install playwright
  playwright install chromium

  python manage.py runserver   # in another terminal

Example:
  python3 scripts/automated_city_tester_browser.py \\
    --cities barcelona --conditions respiratory --routes 4

  # Resume the most recent timestamped CSV after interrupt:
  python3 scripts/automated_city_tester_browser.py --resume --resume-latest

  # Custom name with placeholders {timestamp}, {date}, {time}:
  python3 scripts/automated_city_tester_browser.py \\
    --output pathplanner_comparison_browser_{date}_{time}.csv
"""

from __future__ import print_function

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE_DIR))

sys.path.insert(0, str(BASE_DIR / 'scripts'))
from automated_city_tester_pathplanner import PathPlannerIntegratedTester  # noqa: E402

OUTPUT_PREFIX = 'pathplanner_comparison_browser'
TIMESTAMP_FMT = '%Y%m%d_%H%M%S'
DATE_FMT = '%Y%m%d'
TIME_FMT = '%H%M%S'


def _format_run_timestamp(when: Optional[datetime] = None) -> Dict[str, str]:
    """Tokens for output filenames: YYYYMMDD_HHMMSS, YYYYMMDD, HHMMSS."""
    when = when or datetime.now()
    return {
        'timestamp': when.strftime(TIMESTAMP_FMT),
        'date': when.strftime(DATE_FMT),
        'time': when.strftime(TIME_FMT),
    }


def _default_browser_output_name(when: Optional[datetime] = None) -> str:
    tokens = _format_run_timestamp(when)
    return '{0}_{1}.csv'.format(OUTPUT_PREFIX, tokens['timestamp'])


def _expand_output_template(path_str: str, when: Optional[datetime] = None) -> str:
    """Replace {timestamp}, {date}, {time} in --output template."""
    tokens = _format_run_timestamp(when)
    out = path_str
    for key, value in tokens.items():
        out = out.replace('{' + key + '}', value)
    return out


def _find_latest_browser_csv(directory: Path) -> Optional[Path]:
    """Newest pathplanner_comparison_browser_*.csv by modification time."""
    candidates = sorted(
        directory.glob('{0}_*.csv'.format(OUTPUT_PREFIX)),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def resolve_output_path(
    output_arg: Optional[str],
    base_dir: Path,
    resume: bool = False,
    resume_latest: bool = False,
    run_started: Optional[datetime] = None,
) -> Path:
    """
    Resolve CSV path for this run.

    - Default (no --output): pathplanner_comparison_browser_YYYYMMDD_HHMMSS.csv
    - --output auto|timestamp: same as default
    - --output path with {timestamp}/{date}/{time}: placeholders expanded once at run start
    - --resume --resume-latest: continue newest matching CSV in project root
    - --resume -o FILE: continue that file (fixed name)
    """
    run_started = run_started or datetime.now()

    if resume and (resume_latest or not output_arg):
        latest = _find_latest_browser_csv(base_dir)
        if latest is None:
            raise SystemExit(
                'No {0}_*.csv found in {1}. Run without --resume first.'.format(
                    OUTPUT_PREFIX, base_dir,
                ),
            )
        print('Resuming latest output file:', latest.name)
        return latest

    if not output_arg or output_arg.strip().lower() in ('auto', 'timestamp', 'default'):
        return base_dir / _default_browser_output_name(run_started)

    expanded = _expand_output_template(output_arg.strip(), run_started)
    out_path = Path(expanded)
    if not out_path.is_absolute():
        out_path = base_dir / out_path
    return out_path


def _to_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


# detour_selection values when the UI returns the direct leg (see benchmarkRunner.js)
_FALLBACK_DETOUR_REASONS = frozenset({
    'fallback_direct',
    'no_env_improvement_over_direct',
    'mapbox_collapsed_to_direct',
})


def _mapbox_collapse(std: Dict, opt: Dict) -> bool:
    """
    True when Mapbox geometry collapsed to the direct route and no alternate path
    was selected (same distance + fallback detour reason).
    """
    sd = _to_float(std.get('distance_m'))
    od = _to_float(opt.get('distance_m'))
    if sd is None or od is None:
        return False
    if abs(sd - od) > 0.5:
        return False
    det = (opt.get('detour_selection') or '').strip().lower()
    return det in _FALLBACK_DETOUR_REASONS


def _load_fixed_routes_json(path: Path) -> Dict[str, List[Dict]]:
    """JSON: { \"city_key\": [ {type, start, end, estimated_km?}, ... ] }."""
    with path.open(encoding='utf-8') as f:
        data = json.load(f)
    out: Dict[str, List[Dict]] = {}
    for city_key, routes in data.items():
        normalized = []
        for r in routes:
            start = r.get('start') or [r['start_lat'], r['start_lon']]
            end = r.get('end') or [r['end_lat'], r['end_lon']]
            normalized.append({
                'type': r.get('type', 'pedestrian_fixed'),
                'start': (float(start[0]), float(start[1])),
                'end': (float(end[0]), float(end[1])),
                'estimated_km': _to_float(r.get('estimated_km'), 0.0) or 0.0,
            })
        out[city_key] = normalized
    return out


def _metrics(standard: Dict, optimized: Dict) -> Dict[str, float]:
    out = {
        'time_penalty_pct': 0.0,
        'env_improvement_pct': 0.0,
        'efficiency_index': 0.0,
    }
    s_score = _to_float(standard.get('env_score'))
    o_score = _to_float(optimized.get('env_score'))
    s_dur = _to_float(standard.get('duration_s'))
    o_dur = _to_float(optimized.get('duration_s'))
    if s_score is not None and o_score is not None and s_score > 0:
        out['env_improvement_pct'] = max(
            0.0, ((o_score - s_score) / s_score) * 100.0,
        )
    if s_dur is not None and o_dur is not None and s_dur > 0:
        out['time_penalty_pct'] = ((o_dur - s_dur) / s_dur) * 100.0
    out['efficiency_index'] = out['env_improvement_pct'] - out['time_penalty_pct']
    return out


def _normalize_leg(leg: Dict) -> Dict:
    if not leg:
        return {}
    return {
        'route_name': leg.get('route_name'),
        'distance_m': _to_float(leg.get('distance_m')),
        'duration_s': _to_float(leg.get('duration_s')),
        'env_score': _to_float(leg.get('env_score')),
        'total_score': _to_float(leg.get('total_score')),
        'scoring_method': leg.get('scoring_method'),
        'env_samples': _to_float(leg.get('env_samples')),
        'detour_m': _to_float(leg.get('detour_m')),
        'detour_selection': leg.get('detour_selection'),
        'routing_engine': leg.get('routing_engine'),
    }


def _row_key(row: Dict) -> Tuple:
    """Unique key for resume/skip."""
    return (
        row.get('city'),
        row.get('condition'),
        row.get('route_type'),
        round(_to_float(row.get('start_lat'), 0) or 0, 5),
        round(_to_float(row.get('start_lon'), 0) or 0, 5),
        round(_to_float(row.get('end_lat'), 0) or 0, 5),
        round(_to_float(row.get('end_lon'), 0) or 0, 5),
    )


def _load_completed_keys(path: Path) -> Set[Tuple]:
    if not path.exists():
        return set()
    try:
        df = pd.read_csv(path)
    except Exception:
        return set()
    keys = set()
    for _, r in df.iterrows():
        if pd.notna(r.get('error')) and str(r.get('error', '')).strip():
            continue
        keys.add(_row_key(r.to_dict()))
    return keys


def _append_csv(path: Path, row: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame([row])
    write_header = not path.exists() or path.stat().st_size == 0
    df.to_csv(path, mode='a', header=write_header, index=False)


class BrowserPathPlannerTester:
    def __init__(
        self,
        map_url: str = 'http://127.0.0.1:8000/map/?benchmark=1',
        route_timeout_ms: int = 300000,
        headless: bool = True,
        fast: bool = True,
        pair_retries: int = 3,
        pedestrian_only: bool = True,
        direct_km_min: float = 1.0,
        direct_km_max: float = 3.0,
    ):
        self.map_url = map_url
        self.route_timeout_ms = route_timeout_ms
        self.headless = headless
        self.fast = fast
        self.pair_retries = pair_retries
        self.pedestrian_only = pedestrian_only
        self.direct_km_min = direct_km_min
        self.direct_km_max = direct_km_max
        self.grid_tester = PathPlannerIntegratedTester(route_mode='waypoints')
        self._page = None
        self._browser = None
        self._playwright = None
        self._context = None

    def start_browser(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise SystemExit(
                'Playwright not installed. Run: pip install playwright && playwright install chromium',
            ) from exc

        self._playwright = sync_playwright().start()
        # Use system Google Chrome by default (avoids `playwright install chromium`).
        # Override with PLAYWRIGHT_CHANNEL=chromium to use Playwright's bundled build,
        # or msedge/chrome-beta etc. for another installed channel.
        channel = os.getenv('PLAYWRIGHT_CHANNEL', 'chrome').strip()
        launch_kwargs = {'headless': self.headless}
        if channel and channel.lower() != 'chromium':
            launch_kwargs['channel'] = channel
        self._browser = self._playwright.chromium.launch(**launch_kwargs)
        self._context = self._browser.new_context(
            viewport={'width': 1280, 'height': 800},
            ignore_https_errors=True,
        )
        self._context.set_default_timeout(self.route_timeout_ms)
        self._context.set_default_navigation_timeout(120000)
        self._open_benchmark_page(fast_load=False)

    def _clear_browser_caches(self):
        if not self._page:
            return
        try:
            self._page.evaluate("""() => {
                window.dataCache = {};
                if (typeof window.PathPlannerBenchmark !== 'undefined') {
                    window.currentPatientCondition = null;
                }
            }""")
        except Exception:
            pass

    def _open_benchmark_page(self, fast_load=True):
        if self._page:
            try:
                self._page.close()
            except Exception:
                pass
        self._page = self._context.new_page()
        map_url = self.map_url
        sep = '&' if '?' in map_url else '?'
        if not self.fast and 'full=' not in map_url:
            map_url = map_url + sep + 'full=1'
            sep = '&'
        if self.pedestrian_only and 'pedestrian=' not in map_url:
            map_url = map_url + sep + 'pedestrian=1'
        if self.fast:
            ped_min_m = int(self.direct_km_min * 1000)
            ped_max_m = int(self.direct_km_max * 1000)
            ped_flag = 'true' if self.pedestrian_only else 'false'
            self._page.add_init_script(
                """
                window.BENCHMARK_FAST = true;
                window.BENCHMARK_SKIP_POI = true;
                window.BENCHMARK_MAX_ENV_SAMPLES = 8;
                window.BENCHMARK_MIN_ENV_SAMPLES = 6;
                window.BENCHMARK_MAX_PATTERNS_TO_ROUTE = 2;
                window.BENCHMARK_WAYPOINT_PATTERN_COUNT = 2;
                window.BENCHMARK_MAPBOX_TIMEOUT_MS = 90000;
                window.BENCHMARK_ASTAR_TIMEOUT_MS = 45000;
                window.BENCHMARK_ASTAR_NUM_ROUTES = 1;
                window.BENCHMARK_ASTAR_GRID_M = 150;
                window.BENCHMARK_ENV_CONCURRENCY = 4;
                window.BENCHMARK_MAPBOX_CONCURRENCY = 2;
                window.BENCHMARK_PEDESTRIAN_MODE = {ped_flag};
                window.BENCHMARK_DIRECT_MIN_M = {ped_min_m};
                window.BENCHMARK_DIRECT_MAX_M = {ped_max_m};
                """.format(
                    ped_flag=ped_flag,
                    ped_min_m=ped_min_m,
                    ped_max_m=ped_max_m,
                ),
            )
        # networkidle waits for all map/API traffic — often 60–120s and feels "disconnected"
        wait_mode = 'domcontentloaded' if fast_load else 'networkidle'
        print('Loading benchmark page ({0})…'.format(wait_mode))
        self._page.goto(map_url, wait_until=wait_mode, timeout=120000)
        self._page.wait_for_function(
            '() => window.PathPlannerBenchmark && window.PathPlannerBenchmark.ready === true',
            timeout=120000,
        )
        self._clear_browser_caches()
        cfg = self._page.evaluate(
            '() => window.PathPlannerBenchmark && window.PathPlannerBenchmark.config',
        )
        print('Browser harness ready — config:', json.dumps(cfg or {}))

    def _reset_between_conditions(self, condition: str, index: int, total: int):
        """Fresh page + empty caches between conditions (avoids slowdown / hangs)."""
        print(
            '\n>>> Condition {0}/{1}: {2} — refreshing browser session…'.format(
                index, total, condition,
            ),
        )
        t0 = time.time()
        self._open_benchmark_page(fast_load=True)
        print('>>> Ready for {0} ({1:.0f}s refresh)\n'.format(condition, time.time() - t0))

    def stop_browser(self):
        if self._browser:
            self._browser.close()
        if self._playwright:
            self._playwright.stop()
        self._page = None
        self._browser = None
        self._playwright = None
        self._context = None

    def _reload_on_failure(self):
        print('      Reloading benchmark page after failure…')
        try:
            self._open_benchmark_page(fast_load=True)
        except Exception as exc:
            print(f'      Reload failed: {exc}')

    def run_pair(
        self,
        start: tuple,
        end: tuple,
        condition: str,
    ) -> Dict[str, Any]:
        payload = {
            'startLat': start[0],
            'startLon': start[1],
            'endLat': end[0],
            'endLon': end[1],
            'condition': condition,
        }
        last_err = None
        for attempt in range(self.pair_retries):
            try:
                result = self._page.evaluate(
                    """async (args) => {
                        return await window.PathPlannerBenchmark.runPair(args);
                    }""",
                    payload,
                )
                return result
            except Exception as exc:
                last_err = exc
                print(f'      Attempt {attempt + 1}/{self.pair_retries}: {exc}')
                if attempt < self.pair_retries - 1:
                    time.sleep(2 + attempt)
                    if attempt >= 1:
                        self._reload_on_failure()
        raise last_err

    def test_single_route(self, city_key: str, route: Dict, condition: str) -> Dict:
        od_span_km = route['estimated_km']
        print(
            f"  [{route['type']}] OD span ~{od_span_km:.2f} km "
            f"(not detour cap; max +5 km vs direct) — {condition}",
        )
        t0 = time.time()
        try:
            raw = self.run_pair(route['start'], route['end'], condition)
            if not raw or not isinstance(raw, dict):
                raise ValueError('runPair returned invalid payload: {!r}'.format(raw))
            if raw.get('skipped'):
                reason = raw.get('skip_reason', 'skipped')
                dist = raw.get('standard', {}).get('distance_m')
                print(
                    '      SKIP ({0}) — direct {1}m outside {2}-{3} km band'.format(
                        reason,
                        dist,
                        self.direct_km_min,
                        self.direct_km_max,
                    ),
                )
                return None
            std = _normalize_leg(raw.get('standard', {}))
            opt = _normalize_leg(raw.get('optimized', {}))
            metrics = _metrics(std, opt)
            warnings = []
            for label, leg in (('standard', std), ('optimized', opt)):
                es = leg.get('env_score')
                if es is not None and (es < 1 or es > 10):
                    warnings.append(
                        '{0}_env_score={1} outside 1–10 (invalid scale)'.format(label, es),
                    )
                if leg.get('scoring_method') == 'browser_fallback_default':
                    warnings.append('{0} used default score 5.0'.format(label))
            detour_m = opt.get('detour_m')
            if detour_m is not None and detour_m > 5500:
                warnings.append('optimized_detour_m={0} exceeds 5.5 km policy'.format(detour_m))
            city = self.grid_tester.CITIES[city_key]
            elapsed_s = time.time() - t0
            row = {
                'city': city_key,
                'city_name': city['name'],
                'condition': condition,
                'condition_name': self.grid_tester.CONDITIONS[condition]['name'],
                'route_type': route['type'],
                'engine': 'browser_ui',
                'start_lat': route['start'][0],
                'start_lon': route['start'][1],
                'end_lat': route['end'][0],
                'end_lon': route['end'][1],
                'estimated_km': route['estimated_km'],
                'standard_env_score': std.get('env_score'),
                'standard_distance_m': std.get('distance_m'),
                'standard_duration_s': std.get('duration_s'),
                'standard_route_name': std.get('route_name'),
                'standard_total_score': std.get('total_score'),
                'standard_scoring_method': std.get('scoring_method'),
                'standard_env_samples': std.get('env_samples'),
                'optimized_env_score': opt.get('env_score'),
                'optimized_distance_m': opt.get('distance_m'),
                'optimized_duration_s': opt.get('duration_s'),
                'optimized_route_name': opt.get('route_name'),
                'optimized_scoring_method': opt.get('scoring_method'),
                'optimized_total_score': opt.get('total_score'),
                'optimized_env_samples': opt.get('env_samples'),
                'optimized_detour_m': opt.get('detour_m'),
                'optimized_engine': opt.get('routing_engine'),
                'detour_selection': opt.get('detour_selection'),
                'pedestrian_direct_band_km': (
                    '{0}-{1}'.format(self.direct_km_min, self.direct_km_max)
                    if self.pedestrian_only else ''
                ),
                'max_optimized_detour_m': 5500,
                'patterns_routed': raw.get('patterns_routed'),
                'routes_collected': raw.get('routes_collected'),
                'pair_elapsed_s': round(elapsed_s, 1),
                'js_elapsed_ms': _to_float(raw.get('elapsed_ms')),
                'timestamp': datetime.now().isoformat(),
                **metrics,
            }
            if warnings:
                row['score_warning'] = '; '.join(warnings)
            row['mapbox_collapse'] = _mapbox_collapse(std, opt)
            print(
                f"      OK {elapsed_s:.0f}s — std={std.get('env_score')} "
                f"opt={opt.get('env_score')} detour={opt.get('detour_m')}m "
                f"EI={metrics['efficiency_index']:.1f}%",
            )
            return row
        except Exception as exc:
            elapsed_s = time.time() - t0
            print(f'      FAIL {elapsed_s:.0f}s — {exc}')
            return {
                'city': city_key,
                'condition': condition,
                'route_type': route['type'],
                'engine': 'browser_ui',
                'start_lat': route['start'][0],
                'start_lon': route['start'][1],
                'end_lat': route['end'][0],
                'end_lon': route['end'][1],
                'estimated_km': route['estimated_km'],
                'error': str(exc),
                'pair_elapsed_s': round(elapsed_s, 1),
                'timestamp': datetime.now().isoformat(),
            }

    def compare_cities(
        self,
        city_keys: List[str],
        num_routes: int,
        conditions: List[str],
        output_path: Path,
        resume: bool = False,
        routes_json: Optional[Path] = None,
        benchmark_seed: Optional[int] = None,
    ) -> pd.DataFrame:
        import random

        if benchmark_seed is not None:
            random.seed(benchmark_seed)
            print('Benchmark RNG seed:', benchmark_seed)

        fixed_routes_by_city: Dict[str, List[Dict]] = {}
        if routes_json is not None:
            fixed_routes_by_city = _load_fixed_routes_json(routes_json)
            print('Fixed OD routes from:', routes_json)

        completed = _load_completed_keys(output_path) if resume else set()
        if completed:
            print(f'Resume: skipping {len(completed)} completed OD pairs in {output_path}')

        total_planned = 0
        skipped_resume = 0
        skipped_band = 0
        done = 0
        failed = 0

        self.start_browser()
        interrupted = False
        try:
            for city_key in city_keys:
                print(f"\n=== {city_key} (browser UI) ===")
                n_conditions = len(conditions)
                if self.pedestrian_only:
                    print(
                        'Pedestrian mode: direct Mapbox route '
                        '{0}-{1} km; optimized may add up to 5.5 km detour'.format(
                            self.direct_km_min, self.direct_km_max,
                        ),
                    )
                    pool_batch = max(num_routes * 4, 32)
                else:
                    pool_batch = num_routes * 2

                route_pool: List[Dict] = []
                if city_key in fixed_routes_by_city:
                    route_pool = list(fixed_routes_by_city[city_key])
                    print(
                        '  Using {0} fixed ODs for {1}'.format(
                            len(route_pool), city_key,
                        ),
                    )
                elif not self.pedestrian_only:
                    route_pool = self.grid_tester.generate_test_routes(
                        city_key, pool_batch,
                    )
                elif self.pedestrian_only and benchmark_seed is not None:
                    route_pool = self.grid_tester.generate_pedestrian_test_routes(
                        city_key,
                        pool_batch,
                        direct_km_min=self.direct_km_min,
                        direct_km_max=self.direct_km_max,
                    )

                for cond_i, condition in enumerate(conditions, start=1):
                    if cond_i > 1:
                        self._reset_between_conditions(
                            condition, cond_i, len(conditions),
                        )
                    est_min = int(num_routes * 35 / 60)
                    print(
                        'Condition: {0} (target {1} routes, ~{2} min)'.format(
                            condition, num_routes, est_min,
                        ),
                    )
                    route_idx = 0
                    valid_count = 0
                    skipped_band_cond = 0
                    while valid_count < num_routes:
                        if route_idx >= len(route_pool):
                            if self.pedestrian_only:
                                extra = self.grid_tester.generate_pedestrian_test_routes(
                                    city_key,
                                    pool_batch,
                                    direct_km_min=self.direct_km_min,
                                    direct_km_max=self.direct_km_max,
                                )
                                if not extra:
                                    print(
                                        '  ERROR: could not generate more pedestrian ODs '
                                        '({0}/{1} valid for {2})'.format(
                                            valid_count, num_routes, condition,
                                        ),
                                    )
                                    break
                                route_pool.extend(extra)
                                print(
                                    '  Added {0} ODs to pool (pool size {1}, '
                                    'valid {2}/{3})'.format(
                                        len(extra), len(route_pool),
                                        valid_count, num_routes,
                                    ),
                                )
                            else:
                                print(
                                    '  WARNING: route pool exhausted '
                                    '({0}/{1} for {2})'.format(
                                        valid_count, num_routes, condition,
                                    ),
                                )
                                break
                        route = route_pool[route_idx]
                        route_idx += 1
                        total_planned += 1
                        probe = {
                            'city': city_key,
                            'condition': condition,
                            'route_type': route['type'],
                            'start_lat': route['start'][0],
                            'start_lon': route['start'][1],
                            'end_lat': route['end'][0],
                            'end_lon': route['end'][1],
                        }
                        if resume and _row_key(probe) in completed:
                            skipped_resume += 1
                            valid_count += 1
                            continue
                        if (
                            self.pedestrian_only
                            and route.get('estimated_km', 0)
                            > (self.direct_km_max / 1.35)
                        ):
                            skipped_band += 1
                            skipped_band_cond += 1
                            print(
                                '  [{0}] skip haversine {1:.2f}km '
                                '(likely >{2}km direct) — {3}'.format(
                                    route['type'],
                                    route['estimated_km'],
                                    self.direct_km_max,
                                    condition,
                                ),
                            )
                            continue
                        row = self.test_single_route(city_key, route, condition)
                        if row is None:
                            skipped_band += 1
                            skipped_band_cond += 1
                            continue
                        _append_csv(output_path, row)
                        if row.get('error'):
                            failed += 1
                        else:
                            done += 1
                            valid_count += 1
                            completed.add(_row_key(row))
                        if done % 5 == 0 and done > 0:
                            self._clear_browser_caches()
                        time.sleep(0.15)
                    print(
                        '  {0}: {1}/{2} valid rows ({3} skipped outside '
                        '{4}-{5} km direct band)'.format(
                            condition, valid_count, num_routes, skipped_band_cond,
                            self.direct_km_min, self.direct_km_max,
                        ),
                    )
        except KeyboardInterrupt:
            interrupted = True
            print('\nInterrupted — progress saved to', output_path)
        finally:
            try:
                self.stop_browser()
            except Exception:
                pass
        if interrupted:
            raise SystemExit(130)

        print(
            '\nFinished: {0} ok, {1} failed, {2} resume-skipped, '
            '{3} outside pedestrian band (of {4} attempts)'.format(
                done, failed, skipped_resume, skipped_band, total_planned,
            ),
        )
        if output_path.exists():
            print(f'Saved incrementally → {output_path}')
            return pd.read_csv(output_path)
        return pd.DataFrame()


def main():
    parser = argparse.ArgumentParser(description='PathPlanner browser UI grid benchmark')
    parser.add_argument('--cities', nargs='+', default=['barcelona'])
    parser.add_argument('--routes', type=int, default=4)
    parser.add_argument('--conditions', nargs='+', default=['respiratory'])
    parser.add_argument('--map-url', default=os.getenv(
        'PATHPLANNER_MAP_URL', 'http://127.0.0.1:8000/map/?benchmark=1',
    ))
    parser.add_argument('--route-timeout-ms', type=int, default=300000)
    parser.add_argument('--headed', action='store_true', help='Show browser window')
    parser.add_argument(
        '--output', '-o',
        default=None,
        help=(
            'CSV path. Default: pathplanner_comparison_browser_YYYYMMDD_HHMMSS.csv. '
            'Use "auto" for default, or placeholders {timestamp}, {date}, {time}.'
        ),
    )
    parser.add_argument(
        '--resume',
        action='store_true',
        help='Skip OD pairs already present (no error) in the output CSV',
    )
    parser.add_argument(
        '--resume-latest',
        action='store_true',
        help='With --resume, use the newest pathplanner_comparison_browser_*.csv (ignore --output)',
    )
    parser.add_argument(
        '--full-fidelity',
        action='store_true',
        help='Disable fast init script (more env samples, more Mapbox patterns)',
    )
    parser.add_argument('--pair-retries', type=int, default=3)
    parser.add_argument(
        '--pedestrian-only',
        action=argparse.BooleanOptionalAction,
        default=True,
        help='Sample 1–3 km direct walking ODs only; optimized uses 5.5 km detour cap (default: on)',
    )
    parser.add_argument(
        '--direct-km-min',
        type=float,
        default=1.0,
        help='Min Mapbox direct route length (km) in pedestrian mode',
    )
    parser.add_argument(
        '--direct-km-max',
        type=float,
        default=3.0,
        help='Max Mapbox direct route length (km) in pedestrian mode',
    )
    parser.add_argument(
        '--benchmark-seed',
        type=int,
        default=None,
        help='RNG seed for reproducible pedestrian OD generation (test-retest)',
    )
    parser.add_argument(
        '--routes-json',
        default=None,
        help='JSON file of fixed ODs per city (export with scripts/benchmark_test_retest.py --export-ods)',
    )
    args = parser.parse_args()

    if args.direct_km_min >= args.direct_km_max:
        parser.error('--direct-km-min must be less than --direct-km-max')

    if args.resume_latest and not args.resume:
        parser.error('--resume-latest requires --resume')

    run_started = datetime.now()
    out_path = resolve_output_path(
        args.output,
        BASE_DIR,
        resume=args.resume,
        resume_latest=args.resume_latest,
        run_started=run_started,
    )
    print('Output CSV:', out_path)

    tester = BrowserPathPlannerTester(
        map_url=args.map_url,
        route_timeout_ms=args.route_timeout_ms,
        headless=not args.headed,
        fast=not args.full_fidelity,
        pair_retries=args.pair_retries,
        pedestrian_only=args.pedestrian_only,
        direct_km_min=args.direct_km_min,
        direct_km_max=args.direct_km_max,
    )
    routes_json = Path(args.routes_json) if args.routes_json else None
    tester.compare_cities(
        args.cities,
        args.routes,
        args.conditions,
        output_path=out_path,
        resume=args.resume,
        routes_json=routes_json,
        benchmark_seed=args.benchmark_seed,
    )


if __name__ == '__main__':
    main()
