/* Wake virtual mesh web: copy pane/layout/Rc/demo next to App, then pull them
 * into MEMFS before main() (no --preload-file / file_packager).
 * Linked with: --pre-js web/fs_assets.js
 */
(function () {
  var M = (typeof Module !== "undefined") ? Module : (window.Module = window.Module || {});
  M.preRun = M.preRun || [];

  var ASSETS = [
    "pane/options.pane",
    "layout/layout.json",
    "Rc/defaults/app.json",
    "demo/knot.glb",
    "demo/pirate.glb"
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
