/* Wake virtual mesh web: copy pane/layout/Rc/demo next to App, then pull them
 * into MEMFS before main() (no --preload-file / file_packager).
 * Linked with: --pre-js web/fs_assets.js
 */
(function () {
  var M = (typeof Module !== "undefined") ? Module : (window.Module = window.Module || {});
  M.preRun = M.preRun || [];

  /* Boot payload: small files only. Every entry here is an emscripten RUN
   * DEPENDENCY, so main() does not start until all of them have landed -
   * demo/knot.glb (10 MB) alone was holding the first frame hostage on every
   * visit for a model most sessions never open. The demo models are now
   * downloaded on demand, the first time the menu asks for one
   * (vmesh_load_demo in vmesh_view.hh). */
  var ASSETS = [
    "pane/options.pane",
    "layout/layout.json",
    "Rc/defaults/app.json"
  ];

  function ensureDir(path) {
    var parts = path.split("/");
    var dir = "";
    for (var i = 0; i < parts.length - 1; i++) {
      dir = dir ? (dir + "/" + parts[i]) : parts[i];
      try { FS.mkdir(dir); } catch (e) { /* exists */ }
    }
  }

  function assetUrl(path) {
    var sep = path.indexOf("?") >= 0 ? "&" : "?";
    return path + sep + "_t=" + Date.now();
  }

  function loadOne(path) {
    var dep = "vmesh_asset:" + path;
    addRunDependency(dep);
    fetch(assetUrl(path), { credentials: "same-origin", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(path + " HTTP " + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      var bytes = new Uint8Array(buf);
      ensureDir(path);
      FS.writeFile(path, bytes);
      if (typeof console !== "undefined" && console.info)
        console.info("[fs_assets] mounted", path, "(" + buf.byteLength + " bytes)");
      removeRunDependency(dep);
    }).catch(function (err) {
      if (typeof console !== "undefined" && console.error)
        console.error("[fs_assets] failed", path, err);
      removeRunDependency(dep);
    });
  }

  M.preRun.push(function () {
    for (var i = 0; i < ASSETS.length; i++) loadOne(ASSETS[i]);
  });
})();
