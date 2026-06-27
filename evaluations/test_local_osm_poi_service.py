import json
import sqlite3

from evaluations import environmental_data_service as eds
from evaluations.local_osm_poi_service import (
    fetch_local_named_pois,
    fetch_local_walkability_features,
    init_db,
)


def _insert_poi(conn, *, row_id, category, name, kind, lat, lon):
    conn.execute(
        """
        INSERT INTO poi(id, osm_type, osm_id, category, name, kind, lat, lon, tags)
        VALUES (?, 'node', ?, ?, ?, ?, ?, ?, ?)
        """,
        (row_id, int(row_id), category, name, kind, lat, lon, json.dumps({'name': name})),
    )


def test_fetch_local_named_pois_filters_bbox_and_deduplicates_names(tmp_path):
    db_path = tmp_path / 'pois.sqlite3'
    init_db(db_path)
    with sqlite3.connect(db_path) as conn:
        _insert_poi(conn, row_id='1', category='parks', name='Parco Test', kind='park', lat=44.0, lon=10.0)
        _insert_poi(conn, row_id='2', category='parks', name='Parco Test', kind='park', lat=44.001, lon=10.001)
        _insert_poi(conn, row_id='3', category='parks', name=None, kind='wood', lat=44.002, lon=10.002)
        _insert_poi(conn, row_id='4', category='hospitals', name='Hospital', kind='hospital', lat=44.0, lon=10.0)

    result = fetch_local_named_pois('parks', 43.99, 9.99, 44.01, 10.01, db_path=db_path)

    assert result is not None
    assert result['source'].startswith('OpenStreetMap local PBF SQLite')
    assert result['count'] == 2
    assert [poi['name'] for poi in result['pois']] == ['Parco Test', None]


def test_fetch_named_pois_uses_local_db_without_overpass(monkeypatch, tmp_path):
    db_path = tmp_path / 'pois.sqlite3'
    init_db(db_path)
    with sqlite3.connect(db_path) as conn:
        _insert_poi(conn, row_id='1', category='hospitals', name='Ospedale Test', kind='hospital', lat=44.0, lon=10.0)

    monkeypatch.setenv('LOCAL_OSM_POI_DB', str(db_path))

    def fail_overpass(*args, **kwargs):
        raise AssertionError('Overpass should not be called when local POI DB is configured')

    monkeypatch.setattr(eds, '_overpass_post', fail_overpass)

    result = eds.fetch_named_pois('hospitals', 43.99, 9.99, 44.01, 10.01)

    assert result['count'] == 1
    assert result['pois'][0]['name'] == 'Ospedale Test'
    assert result['source'].startswith('OpenStreetMap local PBF SQLite')


def test_fetch_local_walkability_features_returns_real_osm_tags(tmp_path):
    db_path = tmp_path / 'pois.sqlite3'
    init_db(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO walkability_feature
                (id, osm_type, osm_id, category, name, kind, lat, lon, tags)
            VALUES ('way/10/incline', 'way', 10, 'incline', 'Salita Test', '8%', 44.0, 10.0, ?)
            """,
            (json.dumps({'highway': 'residential', 'incline': '8%'}),),
        )

    result = fetch_local_walkability_features(43.99, 9.99, 44.01, 10.01, db_path=db_path)

    assert result is not None
    assert result['count'] == 1
    assert result['features'][0]['category'] == 'incline'
    assert result['features'][0]['kind'] == '8%'
