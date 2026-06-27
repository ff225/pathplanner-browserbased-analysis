#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${1:-italy}"
JAVA_HEAP="${JAVA_HEAP:-10g}"

case "$REGION" in
  italy)
    PBF="$ROOT_DIR/pbf/italy-260626.osm.pbf"
    GRAPH="$ROOT_DIR/runtime/graphhopper/graphs/italy-gh9"
    ;;
  london)
    PBF="$ROOT_DIR/pbf/greater-london-260626.osm.pbf"
    GRAPH="$ROOT_DIR/runtime/graphhopper/graphs/london-gh9"
    JAVA_HEAP="${JAVA_HEAP:-4g}"
    ;;
  new-york)
    PBF="$ROOT_DIR/pbf/new-york-260626.osm.pbf"
    GRAPH="$ROOT_DIR/runtime/graphhopper/graphs/new-york-gh9"
    JAVA_HEAP="${JAVA_HEAP:-5g}"
    ;;
  *)
    echo "Usage: $0 {italy|london|new-york}" >&2
    exit 2
    ;;
esac

JAR="$ROOT_DIR/runtime/graphhopper/lib/graphhopper-web-9.1.jar"
CONFIG="$ROOT_DIR/runtime/graphhopper/config/pathplanner-demo.yml"

if [[ ! -f "$JAR" ]]; then
  echo "Missing $JAR" >&2
  echo "Download it from Maven Central: com.graphhopper:graphhopper-web:9.1" >&2
  exit 1
fi

if [[ ! -f "$PBF" ]]; then
  echo "Missing $PBF" >&2
  exit 1
fi

if [[ ! -d "$GRAPH" ]]; then
  echo "Graph cache not found, importing $REGION from $PBF"
  java -Xmx"$JAVA_HEAP" \
    -Ddw.graphhopper.datareader.file="$PBF" \
    -Ddw.graphhopper.graph.location="$GRAPH" \
    -jar "$JAR" import "$CONFIG"
fi

exec java -Xmx"$JAVA_HEAP" \
  -Ddw.graphhopper.datareader.file="$PBF" \
  -Ddw.graphhopper.graph.location="$GRAPH" \
  -jar "$JAR" server "$CONFIG"
