// A minimal service worker. It intentionally does nothing — its only job is
// to keep Chrome's extension process infrastructure warm, which measurably
// speeds up opening the chrome://history page (see the v1.7 performance
// adjudication: ~100-130ms faster DOMContentLoaded with the worker present).
chrome.runtime.onInstalled.addListener(() => {})
