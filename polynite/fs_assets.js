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
    "Rc/defaults/app.json",
    /* models/index.txt carries every model's byte size, and the FIRST model
     * starts downloading before main() has had a chance to fetch anything of
     * its own. Fetched late, that download begins with no denominator and its
     * progress bar has nothing to show - which is exactly what the first model
     * of a session used to look like. 2 KB in the boot payload removes the race
     * instead of racing it.
     * Destination is deliberately NOT models/: that path is an IDBFS mount, and
     * a derived index has no business in the user's browser storage. */
    { url: "models/index.txt", dest: "/vmh_index.txt" }
  ];

  function ensureDir(path) {
    var parts = path.split("/");
    var dir = "";
    for (var i = 0; i < parts.length - 1; i++) {
      if (!parts[i]) continue;               /* leading "/" of an absolute path */
      dir = dir ? (dir + "/" + parts[i]) : parts[i];
      try { FS.mkdir(dir); } catch (e) { /* exists */ }
    }
  }

  function assetUrl(path) {
    var sep = path.indexOf("?") >= 0 ? "&" : "?";
    return path + sep + "_t=" + Date.now();
  }

  /* an entry is either "path" (fetched and stored under the same name) or
   * { url: ..., dest: ... } when the two differ */
  function loadOne(entry) {
    var url = entry.url || entry;
    var dest = entry.dest || url;
    var dep = "vmesh_asset:" + dest;
    addRunDependency(dep);
    fetch(assetUrl(url), { credentials: "same-origin", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(url + " HTTP " + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      var bytes = new Uint8Array(buf);
      ensureDir(dest);
      FS.writeFile(dest, bytes);
      if (typeof console !== "undefined" && console.info)
        console.info("[fs_assets] mounted", dest, "(" + buf.byteLength + " bytes)");
      removeRunDependency(dep);
    }).catch(function (err) {
      if (typeof console !== "undefined" && console.error)
        console.error("[fs_assets] failed", url, err);
      removeRunDependency(dep);
    });
  }

  M.preRun.push(function () {
    for (var i = 0; i < ASSETS.length; i++) loadOne(ASSETS[i]);
  });
})();
