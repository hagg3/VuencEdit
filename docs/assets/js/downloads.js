// Upgrades the Downloads page's static release links with live data from the GitHub API.
// Every button already has a working href to .../releases/latest, so a fetch failure or a
// rate-limited response (60 req/hr unauthenticated) just leaves the static fallbacks standing —
// nothing here is load-bearing for the page to function.
(function () {
  var API = "https://api.github.com/repos/hagg3/VuencEdit/releases/latest";

  function formatSize(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function highlightPlatform() {
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    platform = platform.toLowerCase();
    var key = platform.indexOf("mac") !== -1 ? "mac"
      : platform.indexOf("win") !== -1 ? "win"
      : platform.indexOf("linux") !== -1 ? "linux"
      : null;
    if (!key) return;
    var card = document.querySelector('.download-card[data-platform="' + key + '"]');
    if (!card) return;
    card.classList.add("current-platform");
    var badge = document.createElement("span");
    badge.className = "you-badge";
    badge.textContent = "You";
    card.querySelector(".platform-name").appendChild(badge);
  }

  function applyRelease(release) {
    var metaEl = document.getElementById("release-meta");
    if (metaEl) {
      var date = new Date(release.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      metaEl.textContent = release.tag_name + " · released " + date;
    }

    document.querySelectorAll("[data-suffix]").forEach(function (el) {
      var suffix = el.getAttribute("data-suffix");
      var asset = release.assets.find(function (a) { return a.name.endsWith(suffix); });
      if (!asset) return;
      el.href = asset.browser_download_url;
      var sizeEl = el.parentElement.querySelector(".file-meta");
      if (sizeEl) sizeEl.textContent = asset.name + " · " + formatSize(asset.size);
    });
  }

  highlightPlatform();

  fetch(API).then(function (r) {
    if (!r.ok) throw new Error("release fetch failed");
    return r.json();
  }).then(applyRelease).catch(function () {
    // Static fallback hrefs already point at /releases/latest — nothing to do.
  });
})();
