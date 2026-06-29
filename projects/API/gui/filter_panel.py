import tkinter as tk
from tkinter import ttk

class FilterPanel(tk.Toplevel):
    def __init__(self, master, overlay_manager, **kwargs):
        super().__init__(master, **kwargs)
        self.title("Filter Layers")
        self.overlay_manager = overlay_manager
        self._active_filters = []  # list of (key, value)

        # UI elements
        self.key_label = ttk.Label(self, text="Tag Key:")
        self.key_label.grid(row=0, column=0, padx=5, pady=5, sticky='w')
        self.key_entry = ttk.Entry(self, width=20)
        self.key_entry.grid(row=0, column=1, padx=5, pady=5)

        self.value_label = ttk.Label(self, text="Tag Value:")
        self.value_label.grid(row=1, column=0, padx=5, pady=5, sticky='w')
        self.value_entry = ttk.Entry(self, width=20)
        self.value_entry.grid(row=1, column=1, padx=5, pady=5)

        self.add_button = ttk.Button(self, text="Add Filter", command=self._add_filter)
        self.add_button.grid(row=2, column=0, columnspan=2, pady=5)

        self.listbox = tk.Listbox(self, height=10, width=30)
        self.listbox.grid(row=3, column=0, columnspan=2, padx=5, pady=5, sticky='nsew')

        self.remove_button = ttk.Button(self, text="Remove Selected", command=self._remove_filter)
        self.remove_button.grid(row=4, column=0, padx=5, pady=5, sticky='w')

        self.clear_button = ttk.Button(self, text="Clear All", command=self._clear_all)
        self.clear_button.grid(row=4, column=1, padx=5, pady=5, sticky='e')

        self.status_label = ttk.Label(self, text="")
        self.status_label.grid(row=5, column=0, columnspan=2, pady=2)

        self.grid_rowconfigure(3, weight=1)
        self.grid_columnconfigure(1, weight=1)

        self.protocol("WM_DELETE_WINDOW", self.withdraw)  # hide instead of destroy

    def _add_filter(self):
        key = self.key_entry.get().strip()
        value = self.value_entry.get().strip()
        if not key or not value:
            self.status_label.config(text="Both key and value required")
            return
        if (key, value) in self._active_filters:
            self.status_label.config(text="Filter already exists")
            return
        self._active_filters.append((key, value))
        self.listbox.insert(tk.END, f"{key}={value}")
        self.key_entry.delete(0, tk.END)
        self.value_entry.delete(0, tk.END)
        self.status_label.config(text="Filter added")
        self.overlay_manager.add_filter(key, value)

    def _remove_filter(self):
        sel = self.listbox.curselection()
        if not sel:
            self.status_label.config(text="Select a filter to remove")
            return
        index = sel[0]
        item = self.listbox.get(index)
        key, value = item.split('=', 1)
        self._active_filters.remove((key, value))
        self.listbox.delete(index)
        self.status_label.config(text="Filter removed")
        self.overlay_manager.remove_filter(key, value)

    def _clear_all(self):
        for key, value in self._active_filters[:]:
            self.overlay_manager.remove_filter(key, value)
        self._active_filters.clear()
        self.listbox.delete(0, tk.END)
        self.status_label.config(text="All filters cleared")

    def get_filters(self):
        return list(self._active_filters)
