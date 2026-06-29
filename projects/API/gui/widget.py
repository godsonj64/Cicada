import tkinter as tk
from PIL import Image, ImageTk
from gui.tiles import TileManager, latlon_to_tile, tile_to_latlon

class MapWidget(tk.Canvas):
    def __init__(self, master, initial_lat=40.7128, initial_lon=-74.0060, initial_zoom=12, **kwargs):
        super().__init__(master, bg='lightgray', **kwargs)
        self.zoom = initial_zoom
        self.tile_manager = TileManager()
        self.tile_manager.on_tile_ready = self._on_tile_ready
        self.overlay_manager = None  # will be set later

        # Set initial center in pixel coordinates (tile coords * 256)
        center_tile_x, center_tile_y = latlon_to_tile(initial_lat, initial_lon, self.zoom)
        self.offset_x = -center_tile_x * 256 + self.winfo_width() // 2
        self.offset_y = -center_tile_y * 256 + self.winfo_height() // 2

        # Bind mouse events
        self.bind("<ButtonPress-1>", self._on_mouse_down)
        self.bind("<B1-Motion>", self._on_mouse_drag)
        self.bind("<ButtonRelease-1>", self._on_mouse_release)
        self.bind("<Double-Button-1>", self._on_double_click)
        self.bind("<Button-3>", self._on_right_click)
        self.bind("<MouseWheel>", self._on_mouse_wheel)
        self.bind("<Configure>", self._on_resize)
        self.bind_all("<Key>", self._on_key)

        self._drag_start = None
        self._draw_tiles()

    def set_overlay_manager(self, mgr):
        """Set the OverlayManager and register the redraw callback."""
        self.overlay_manager = mgr
        mgr.on_data_ready = self._redraw_overlay

    def _redraw_overlay(self):
        if self.overlay_manager:
            self.overlay_manager.draw_overlay(self, self.zoom, self.offset_x, self.offset_y,
                                              self.winfo_width(), self.winfo_height())

    def _screen_to_latlon(self, sx, sy):
        """Convert screen pixel coordinates to (lat, lon)."""
        tile_x = (sx - self.offset_x) / 256.0
        tile_y = (sy - self.offset_y) / 256.0
        return tile_to_latlon(tile_x, tile_y, self.zoom)

    def _on_resize(self, event):
        self._draw_tiles()

    def _on_mouse_down(self, event):
        self._drag_start = (event.x, event.y)

    def _on_mouse_release(self, event):
        if self._drag_start:
            dx = event.x - self._drag_start[0]
            dy = event.y - self._drag_start[1]
            if abs(dx) < 5 and abs(dy) < 5:
                self._on_click(event)
        self._drag_start = None

    def _on_click(self, event):
        lat, lon = self._screen_to_latlon(event.x, event.y)
        print(f"Clicked: {lat:.6f}, {lon:.6f} (zoom={self.zoom})")

    def _on_double_click(self, event):
        if self.zoom < 18:
            self._zoom_at_point(event.x, event.y, 1)

    def _on_right_click(self, event):
        if self.zoom > 1:
            self._zoom_at_point(event.x, event.y, -1)

    def _zoom_at_point(self, screen_x, screen_y, direction):
        lat, lon = self._screen_to_latlon(screen_x, screen_y)
        new_zoom = self.zoom + direction
        new_zoom = max(1, min(18, new_zoom))
        if new_zoom == self.zoom:
            return
        new_tile_x, new_tile_y = latlon_to_tile(lat, lon, new_zoom)
        self.offset_x = -new_tile_x * 256 + screen_x
        self.offset_y = -new_tile_y * 256 + screen_y
        self.zoom = new_zoom
        self._draw_tiles()

    def _on_mouse_drag(self, event):
        if self._drag_start:
            dx = event.x - self._drag_start[0]
            dy = event.y - self._drag_start[1]
            self.offset_x += dx
            self.offset_y += dy
            self._drag_start = (event.x, event.y)
            self._draw_tiles()

    def _on_mouse_wheel(self, event):
        direction = 1 if event.delta > 0 else -1
        new_zoom = self.zoom + direction
        new_zoom = max(1, min(18, new_zoom))
        if new_zoom == self.zoom:
            return
        center_x = self.winfo_width() / 2
        center_y = self.winfo_height() / 2
        lat, lon = self._screen_to_latlon(center_x, center_y)
        new_tile_x, new_tile_y = latlon_to_tile(lat, lon, new_zoom)
        self.zoom = new_zoom
        self.offset_x = -new_tile_x * 256 + center_x
        self.offset_y = -new_tile_y * 256 + center_y
        self._draw_tiles()

    def _on_key(self, event):
        key = event.keysym
        pan_amount = 128
        if key == "Up":
            self.offset_y += pan_amount
            self._draw_tiles()
        elif key == "Down":
            self.offset_y -= pan_amount
            self._draw_tiles()
        elif key == "Left":
            self.offset_x += pan_amount
            self._draw_tiles()
        elif key == "Right":
            self.offset_x -= pan_amount
            self._draw_tiles()

    def _draw_tiles(self):
        self.delete("tile")
        w = self.winfo_width()
        h = self.winfo_height()
        if w <= 1 or h <= 1:
            return
        # Determine tile range from screen bounds
        min_tx = int((-self.offset_x) / 256.0)
        max_tx = int((w - self.offset_x) / 256.0) + 1
        min_ty = int((-self.offset_y) / 256.0)
        max_ty = int((h - self.offset_y) / 256.0) + 1
        for tx in range(min_tx, max_tx):
            for ty in range(min_ty, max_ty):
                # tile numbers can wrap around the world longitude
                wrapped_tx = tx % (1 << self.zoom)
                if wrapped_tx != tx:
                    continue
                if ty < 0 or ty >= (1 << self.zoom):
                    continue
                photo = self.tile_manager.get_tile(self.zoom, wrapped_tx, ty)
                if photo:
                    x = tx * 256 + self.offset_x
                    y = ty * 256 + self.offset_y
                    self.create_image(x, y, anchor='nw', image=photo, tags='tile')
        # Redraw overlay after tiles
        self._redraw_overlay()

    def _on_tile_ready(self, zoom, x, y, photo):
        # Called from background thread -> schedule UI update
        self.after(0, self._draw_tiles)
