import requests
import json
from threading import Thread, Lock
from collections import defaultdict

OVERLAY_API_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_QUERY = """
[out:json][bbox:{south},{west},{north},{east}];
(node["{key}"="{value}"](bbox); way["{key}"="{value}"](bbox); rel["{key}"="{value}"](bbox););
out body geom;
"""

class OverlayManager:
    def __init__(self):
        self._features = []          # list of dicts: { type, geometry, tags }
        self._cache = {}             # (bbox_key, key, value) -> features list
        self._lock = Lock()
        self._active_filters = []    # list of (key, value)
        self.on_data_ready = None    # callback()
        self._pending_query = None

    def set_active_filters(self, filters):
        """filters: list of (key, value) tuples"""
        with self._lock:
            self._active_filters = list(filters)
        self._trigger_fetch()

    def add_filter(self, key, value):
        with self._lock:
            if (key, value) not in self._active_filters:
                self._active_filters.append((key, value))
        self._trigger_fetch()

    def remove_filter(self, key, value):
        with self._lock:
            if (key, value) in self._active_filters:
                self._active_filters.remove((key, value))
        self._trigger_fetch()

    def _trigger_fetch(self):
        if self._pending_query is not None:
            self._pending_query.cancel()
        debounce_ms = 300
        self._pending_query = Thread(target=self._delayed_fetch, args=(debounce_ms/1000.0,))
        self._pending_query.start()

    def _delayed_fetch(self, delay):
        import time
        time.sleep(delay)
        self._pending_query = None
        self._fetch_all()

    def _fetch_all(self):
        with self._lock:
            filters = list(self._active_filters)
        if not filters:
            with self._lock:
                self._features = []
            if self.on_data_ready:
                self.on_data_ready()
            return

        all_features = []
        # We'll fetch each filter separately; assume a fixed bbox for now (world)
        bbox = (-90, -180, 90, 180)  # south, west, north, east
        for key, value in filters:
            cache_key = (bbox, key, value)
            with self._lock:
                if cache_key in self._cache:
                    all_features.extend(self._cache[cache_key])
                    continue
            # Fetch
            query = OVERPASS_QUERY.format(south=bbox[0], west=bbox[1],
                                          north=bbox[2], east=bbox[3],
                                          key=key, value=value)
            try:
                resp = requests.post(OVERLAY_API_URL, data={'data': query},
                                     headers={'User-Agent': 'OSMViewer/1.0'},
                                     timeout=10)
                data = resp.json()
                parsed = self._parse_overpass_response(data)
                with self._lock:
                    self._cache[cache_key] = parsed
                all_features.extend(parsed)
            except Exception as e:
                print(f"Overpass fetch error for {key}={value}: {e}")
        with self._lock:
            self._features = all_features
        if self.on_data_ready:
            self.on_data_ready()

    def _parse_overpass_response(self, data):
        features = []
        elements = data.get('elements', [])
        for elem in elements:
            typ = elem.get('type')
            tags = elem.get('tags', {})
            geom = elem.get('geometry')
            if typ == 'node':
                # node: geometry is a single point
                lat = elem.get('lat')
                lon = elem.get('lon')
                if lat is not None and lon is not None:
                    geom = [{'lat': lat, 'lon': lon}]
                # geom should be list of one point
                if geom and len(geom) >= 1:
                    features.append({
                        'type': 'node',
                        'geometry': [(p['lon'], p['lat']) for p in geom],
                        'tags': tags
                    })
            elif typ in ('way', 'relation'):
                if geom:
                    # geometry is list of points
                    features.append({
                        'type': typ,
                        'geometry': [(p['lon'], p['lat']) for p in geom],
                        'tags': tags
                    })
        return features

    def get_features(self):
        with self._lock:
            return list(self._features)

    def draw_overlay(self, canvas, zoom, offset_x, offset_y, width, height):
        """Draw features onto the canvas."""
        canvas.delete("overlay")
        features = self.get_features()
        if not features:
            return
        import math
        from gui.tiles import latlon_to_tile
        # Convert each feature's geometry to screen coordinates
        for feat in features:
            geom = feat['geometry']
            if not geom:
                continue
            screen_points = []
            for lon, lat in geom:
                tx, ty = latlon_to_tile(lat, lon, zoom)
                sx = tx * 256 + offset_x
                sy = ty * 256 + offset_y
                screen_points.append((sx, sy))
            if feat['type'] == 'node':
                if screen_points:
                    cx, cy = screen_points[0]
                    r = 4
                    canvas.create_oval(cx-r, cy-r, cx+r, cy+r,
                                       fill='red', outline='black', tags='overlay')
            else:
                # line/polygon
                if len(screen_points) > 1:
                    canvas.create_line(screen_points, fill='blue', width=2,
                                       smooth=True, tags='overlay')
