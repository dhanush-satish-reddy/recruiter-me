// © 2026 Dhanush Satish Reddy. All rights reserved. See LICENSE.
// Applies the saved light/dark choice before the page paints (no flash).
// Without a saved choice, the page follows the device's dark-mode setting.
(function () {
  try {
    var t = localStorage.getItem("rm-theme");
    if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  } catch (e) { /* storage unavailable: follow the device setting */ }
})();
