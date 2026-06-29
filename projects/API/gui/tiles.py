import math
import urllib.request
import io
import threading
from PIL import Image, ImageTk

TILE_SIZE = 256
TILE_URL_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
USER_AGENT = "Mozilla/5.0 (compatible; OSMViewer/1.0)"

class TileManager:
    def __init__(self):
        self._cache = {}      # (zoom, x, y) -> ImageTk.PhotoImage
        self._pending = set() # (zoom, x, y) currently being fetched
        self._lock = threading.Lock()
        self.on_tile_ready = None  # callback(zoom, x, y, photo)

    def get_tile(self, zoom, x, y):
        key = (zoom, x, y)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
            if key in self._pending:
                return None  # already being fetched
            self._pending.add(key)

        # Start background fetch
        thread = threading.Thread(target=self._fetch_tile, args=(zoom, x, y), daemon=True)
        thread.start()
        return None

    def _fetch_tile(self, zoom, x, y):
        key = (zoom, x, y)
        url = get_tile_url(zoom, x, y)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=5) as response:
                data = response.read()
            pil_img = Image.open(io.BytesIO(data)).convert("RGB")
            photo = ImageTk.PhotoImage(pil_img)
        except Exception:
            # Use a placeholder on failure
            placeholder = Image.new("RGB", (TILE_SIZE, TILE_SIZE), (200, 200, 200))
            photo = ImageTk.PhotoImage(placeholder)

        with self._lock:
            self._cache[key] = photo
            self._pending.discard(key)

        if self.on_tile_ready:
            self.on_tile_ready(zoom, x, y, photo)

def get_tile_url(z, x, y):
    return TILE_URL_TEMPLATE.format(z=z, x=x, y=y)

def latlon_to_tile(lat, lon, zoom):
    """Convert latitude, longitude to tile coordinates (floating point)."""
    lat_rad = math.radians(lat)
    n = 2.0 ** zoom
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.log(math.tan(lat_rad) + (1.0 / math.cos(lat_rad))) / math.pi) / 2.0 * n
    return x, y

def tile_to_latlon(x, y, zoom):
    """Convert tile coordinates (floating point) to (lat, lon)."""
    n = 2.0 ** zoom
    lon = x / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n)))
    lat = math.degrees(lat_rad)
    return lat, lon
