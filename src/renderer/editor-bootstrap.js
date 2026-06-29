// Configures Monaco's web worker to load locally under file:// using a Blob worker.
// Must execute before the AMD loader and editor.main.
(function () {
  var vsBase = new URL('../../node_modules/monaco-editor/min/', window.location.href).href;
  window.__GARM_VS__ = vsBase + 'vs';
  self.MonacoEnvironment = {
    getWorkerUrl: function () {
      var code =
        "self.MonacoEnvironment={baseUrl:'" + vsBase + "'};" +
        "importScripts('" + vsBase + "vs/base/worker/workerMain.js');";
      var blob = new Blob([code], { type: 'application/javascript' });
      return URL.createObjectURL(blob);
    },
  };
})();
