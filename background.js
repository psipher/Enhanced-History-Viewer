import chrome from "chrome"

chrome.runtime.onInstalled.addListener(() => {
  console.log("Enhanced History Viewer installed")
})

