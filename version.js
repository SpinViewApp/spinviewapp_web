(function(){
  function getStoredVersion() {
    try { return localStorage.getItem('siteVersion') || null; }
    catch(_) { return null; }
  }

  function setStoredVersion(v) {
    try { localStorage.setItem('siteVersion', v); } catch(_) {}
  }

  function getLastReloadVersion() {
    try { return sessionStorage.getItem('lastReloadVersion') || null; }
    catch(_) { return null; }
  }

  function setLastReloadVersion(v) {
    try { sessionStorage.setItem('lastReloadVersion', v); } catch(_) {}
  }

  var storedVersion = getStoredVersion();

  fetch("version.txt?_=" + Date.now(), { cache: "no-store" })
    .then(r => r.text())
    .then(remoteVersion => {
      remoteVersion = remoteVersion.trim();
      if (!remoteVersion) return;

      // If the fetched version is different from stored one
      if (remoteVersion !== storedVersion) {
        setStoredVersion(remoteVersion);

        // Avoid reload loop if already reloaded for this version
        if (getLastReloadVersion() === remoteVersion) return;
        setLastReloadVersion(remoteVersion);

        // Force reload with cache-busting based on version
        var url = new URL(location.href);
        url.searchParams.set('_v', remoteVersion);
        location.replace(url.toString());
      }
    })
    .catch(() => { /* optional: ignore errors silently */ });
})();
