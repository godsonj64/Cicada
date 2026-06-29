import tkinter as tk
from gui.widget import MapWidget
from gui.overlay import OverlayManager
from gui.filter_panel import FilterPanel

def main():
    root = tk.Tk()
    root.title("OSM Viewer with Overlay")

    overlay_mgr = OverlayManager()

    map_widget = MapWidget(root, initial_lat=40.7128, initial_lon=-74.0060, initial_zoom=12)
    map_widget.pack(fill=tk.BOTH, expand=True)

    # Connect overlay manager to map
    map_widget.set_overlay_manager(overlay_mgr)

    def on_overlay_data_ready():
        # Redraw overlay on map when data arrives
        map_widget.redraw_overlay()

    overlay_mgr.on_data_ready = on_overlay_data_ready

    # Create filter panel (shown immediately)
    filter_panel = FilterPanel(root, overlay_mgr)

    # Bind 'F' key to show/hide filter panel
    def toggle_filter_panel(event):
        if filter_panel.winfo_viewable():
            filter_panel.withdraw()
        else:
            filter_panel.deiconify()

    root.bind_all('<Key-f>', toggle_filter_panel)

    root.mainloop()

if __name__ == "__main__":
    main()