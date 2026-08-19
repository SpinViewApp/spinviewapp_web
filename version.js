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

  function appendVersion(url, version) {
    if (!url) return url;

    try {
      var u = new URL(url, location.href);
      u.searchParams.set('_v', version);

      if (u.origin === location.origin) {
        return u.pathname + u.search + u.hash;
      }

      return u.toString();
    } catch (_) {
      var sep = url.indexOf('?') >= 0 ? '&' : '?';
      return url + sep + '_v=' + encodeURIComponent(version);
    }
  }

  function versionAssets(version) {
    var nodes = document.querySelectorAll('[data-version-src]');
    var i;

    for (i = 0; i < nodes.length; i++) {
      var source = nodes[i].getAttribute('data-version-src');
      if (!source) continue;
      nodes[i].setAttribute('src', appendVersion(source, version));
    }
  }

  var storedVersion = getStoredVersion();

  fetch("/version.txt?_=" + Date.now(), { cache: "no-store" })
    .then(function(r) { return r.text(); })
    .then(function(remoteVersion) {
      remoteVersion = remoteVersion.trim();
      if (!remoteVersion) return;

      window.SPINVIEW_VERSION = remoteVersion;

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          versionAssets(remoteVersion);
        }, { once: true });
      } else {
        versionAssets(remoteVersion);
      }

      if (remoteVersion !== storedVersion) {
        setStoredVersion(remoteVersion);

        if (getLastReloadVersion() === remoteVersion) return;
        setLastReloadVersion(remoteVersion);

        var url = new URL(location.href);
        url.searchParams.set('_v', remoteVersion);
        location.replace(url.toString());
      }
    })
    .catch(function() {});
})();
