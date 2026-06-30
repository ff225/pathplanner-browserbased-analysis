import json
import sqlite3

from evaluations.local_osm_poi_service import init_db
from scripts import check_runtime_config


def _write_valid_db(path):
    init_db(path)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            INSERT INTO poi(id, osm_type, osm_id, category, name, kind, lat, lon, tags)
            VALUES ('poi/1', 'node', 1, 'parks', 'Park', 'park', 44.0, 10.0, '{}')
            """
        )
        conn.execute(
            """
            INSERT INTO walkability_feature
                (id, osm_type, osm_id, category, name, kind, lat, lon, tags)
            VALUES ('walk/1', 'way', 1, 'surface', NULL, 'asphalt', 44.0, 10.0, '{}')
            """
        )
        conn.commit()
        conn.execute('PRAGMA journal_mode=DELETE').fetchone()
        conn.commit()
    finally:
        conn.close()


def test_runtime_config_redacts_secret_values(tmp_path, monkeypatch):
    db_path = tmp_path / 'pois.sqlite3'
    pbf_path = tmp_path / 'extract.osm.pbf'
    _write_valid_db(db_path)
    pbf_path.write_bytes(b'pbf')
    env_path = tmp_path / '.env'
    secret = 'super-secret-token'
    env_path.write_text(
        '\n'.join(
            [
                f'DJANGO_SECRET_KEY={secret}',
                'DJANGO_ALLOWED_HOSTS=localhost',
                'GRAPHHOPPER_URL=http://graphhopper.test',
                f'LOCAL_OSM_POI_DB={db_path}',
                f'LOCAL_OSM_PBF_PATH={pbf_path}',
                f'MAPBOX_ACCESS_TOKEN={secret}',
            ]
        )
    )
    monkeypatch.setattr(
        check_runtime_config,
        '_check_graphhopper',
        lambda url, timeout: {'ok': True, 'url': url, 'profiles': ['foot', 'bike', 'car']},
    )

    result = check_runtime_config.check_runtime_config(
        env_files=[env_path],
        require_mapbox=True,
        require_pbf=True,
    )

    serialized = json.dumps(result)
    assert result['ok'] is True
    assert secret not in serialized
    assert result['local_db']['poi'] == 1
    assert result['local_db']['walkability_feature'] == 1
    assert result['pbf']['ok'] is True


def test_runtime_config_reports_missing_required_keys(tmp_path, monkeypatch):
    for key in (
        'DJANGO_SECRET_KEY',
        'GRAPHHOPPER_URL',
        'LOCAL_OSM_POI_DB',
        'MAPBOX_ACCESS_TOKEN',
        'OPENAQ_API_KEY',
    ):
        monkeypatch.delenv(key, raising=False)
    env_path = tmp_path / '.env'
    env_path.write_text('DJANGO_ALLOWED_HOSTS=localhost\n')

    result = check_runtime_config.check_runtime_config(
        env_files=[env_path],
        check_graphhopper=False,
        check_local_db=False,
    )

    assert result['ok'] is False
    assert 'DJANGO_SECRET_KEY is required' in result['errors']
    assert 'GRAPHHOPPER_URL is required for local real-data routing' in result['errors']
    assert 'LOCAL_OSM_POI_DB is required for local real-data routing' in result['errors']


def test_runtime_config_accepts_regional_routing_specs(tmp_path, monkeypatch):
    italy_db = tmp_path / 'italy.sqlite3'
    london_db = tmp_path / 'london.sqlite3'
    _write_valid_db(italy_db)
    _write_valid_db(london_db)
    env_path = tmp_path / '.env'
    env_path.write_text(
        '\n'.join(
            [
                'DJANGO_SECRET_KEY=secret',
                'DJANGO_ALLOWED_HOSTS=localhost',
                (
                    'PATHPLANNER_ROUTING_REGIONS='
                    f'italy|43.0,9.0,45.0,11.0|http://gh-italy:8989|{italy_db};'
                    f'london|51.0,-0.5,52.0,0.2|http://gh-london:8989|{london_db}'
                ),
            ]
        )
    )

    monkeypatch.setattr(
        check_runtime_config,
        '_check_graphhopper',
        lambda url, timeout: {'ok': True, 'url': url, 'profiles': ['foot', 'bike', 'car']},
    )

    result = check_runtime_config.check_runtime_config(env_files=[env_path])

    assert result['ok'] is True
    assert len(result['graphhopper']) == 2
    assert len(result['regional_local_dbs']) == 2
