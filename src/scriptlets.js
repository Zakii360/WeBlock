(() => {
  'use strict';

  // Best-effort compatibility shim for pages that use the common ad-presence
  // flag. It intentionally does not monkey-patch fetch(), XMLHttpRequest,
  // YouTube player responses, or video playback internals.
  try {
    if (!Object.prototype.hasOwnProperty.call(window, 'canRunAds')) {
      Object.defineProperty(window, 'canRunAds', {
        configurable: true,
        enumerable: false,
        get() {
          return true;
        }
      });
    }
  } catch {
    // A page may have locked down the global object before the script ran.
  }
})();
