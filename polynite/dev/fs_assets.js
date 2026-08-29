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

  /* Is there a model library one level ABOVE this page?
   *
   * That is the whole question behind the Dev / Release tabs, and it is the
   * only honest way to ask it. The page location cannot answer: a dev server
   * rooted ON the dev folder serves it as "/", so looking for a "dev" segment
   * in the path found nothing and the release layout was assumed. Nor can a
   * build flag answer, because deploying is a COPY of dev/ over the site - the
   * flag would travel with it and lie about where it landed.
   *
   * A parent index.txt is a fact about the deploy, checked where it is used.
   * HEAD, so nothing is downloaded, and a 404 here is an ANSWER, not a
   * failure: it means this page IS the site. Run as a boot dependency so
   * main() starts with the answer already in hand - the library table is
   * built before the first model is asked for, and never has to be rebuilt
   * underneath it. */
  function probeParentLib() {
    var dep = "vmesh_parent_lib";
    M.vmeshParentLib = 0;
    addRunDependency(dep);
    fetch(assetUrl("../models/index.txt"),
          { method: "HEAD", credentials: "same-origin", cache: "no-store" })
      .then(function (res) { M.vmeshParentLib = res.ok ? 1 : 0; })
      .catch(function () { M.vmeshParentLib = 0; })
      .then(function () {
        if (typeof console !== "undefined" && console.info)
          console.info("[fs_assets] parent model library",
            M.vmeshParentLib ? "found -> this is a nested deploy (dev)"
                             : "absent -> this page is the site");
        removeRunDependency(dep);
      });
  }

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
    probeParentLib();
    for (var i = 0; i < ASSETS.length; i++) loadOne(ASSETS[i]);
  });
})();
