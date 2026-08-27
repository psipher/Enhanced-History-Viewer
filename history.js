let lastFetchedTime = new Date().getTime()
let isLoading = false
const ITEMS_PER_PAGE = 50
let searchQuery = ''
let selectedUrls = new Set() // Track selected URLs for bulk actions

let searchTimeout
let currentSearchRequestId = 0
let hasMoreHistory = true
let lastCheckedCheckbox = null
const renderedUrls = new Set()
const renderedItems = new Map()
const dateGroups = new Map()
const visitStatusCache = new Map()
const visitStatusVersions = new Map()
const visitLookupQueue = []
const VISIT_STATUS_TTL_MS = 60 * 1000
const MAX_CONCURRENT_VISIT_LOOKUPS = 6
const DEVICE_CACHE_TTL_MS = 30 * 1000
let activeVisitLookups = 0
let historyObserver = null
let deviceCache = null

function formatDate(date) {
  // Create date objects with time set to midnight for proper day comparison
  const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  const now = new Date()
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const yesterday = new Date(todayDate)
  yesterday.setDate(yesterday.getDate() - 1)

  const formattedFullDate = date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  if (itemDate.getTime() === todayDate.getTime()) {
    return `Today - ${formattedFullDate}`
  } else if (itemDate.getTime() === yesterday.getTime()) {
    return `Yesterday - ${formattedFullDate}`
  } else {
    return formattedFullDate
  }
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function getHostname(urlStr) {
  try {
    return new URL(urlStr).hostname
  } catch {
    return urlStr || ''
  }
}

function getFaviconUrl(url) {
  try {
    const chromeFaviconUrl = new URL(chrome.runtime.getURL('/_favicon/'))
    chromeFaviconUrl.searchParams.set('pageUrl', url)
    chromeFaviconUrl.searchParams.set('size', '32')
    return chromeFaviconUrl.toString()
  } catch {
    const domain = getHostname(url)
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
  }
}

function getDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getCachedVisitStatus(url) {
  const cached = visitStatusCache.get(url)
  if (cached?.promise) return undefined
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached && !cached.promise) visitStatusCache.delete(url)
    return undefined
  }
  return cached.isLocal
}

function processVisitLookupQueue() {
  while (activeVisitLookups < MAX_CONCURRENT_VISIT_LOOKUPS && visitLookupQueue.length > 0) {
    const lookup = visitLookupQueue.shift()
    activeVisitLookups++

    chrome.history.getVisits({ url: lookup.url }, (visits) => {
      let isLocal = true
      let mostRecentVisit = null

      if (!chrome.runtime.lastError && visits) {
        for (const visit of visits) {
          if (!mostRecentVisit || visit.visitTime > mostRecentVisit.visitTime) {
            mostRecentVisit = visit
          }
        }
        isLocal = mostRecentVisit?.isLocal !== false
      }

      activeVisitLookups--

      if ((visitStatusVersions.get(lookup.url) || 0) !== lookup.version) {
        getVisitStatus(lookup.url).then(lookup.resolve)
        processVisitLookupQueue()
        return
      }

      visitStatusCache.set(lookup.url, {
        isLocal,
        expiresAt: Date.now() + VISIT_STATUS_TTL_MS,
        promise: null,
      })
      lookup.resolve(isLocal)
      processVisitLookupQueue()
    })
  }
}

function getVisitStatus(url, prioritize = false) {
  const cachedStatus = getCachedVisitStatus(url)
  if (cachedStatus !== undefined) return Promise.resolve(cachedStatus)

  const cached = visitStatusCache.get(url)
  if (cached?.promise) {
    if (prioritize) {
      const queuedIndex = visitLookupQueue.findIndex((lookup) => lookup.url === url)
      if (queuedIndex > 0) {
        visitLookupQueue.unshift(visitLookupQueue.splice(queuedIndex, 1)[0])
      }
    }
    return cached.promise
  }

  let resolveLookup
  const promise = new Promise((resolve) => {
    resolveLookup = resolve
  })
  visitStatusCache.set(url, {
    isLocal: true,
    expiresAt: Date.now() + VISIT_STATUS_TTL_MS,
    promise,
  })
  const lookup = {
    url,
    resolve: resolveLookup,
    version: visitStatusVersions.get(url) || 0,
  }
  if (prioritize) visitLookupQueue.unshift(lookup)
  else visitLookupQueue.push(lookup)
  processVisitLookupQueue()
  return promise
}

function invalidateVisitStatus(url) {
  visitStatusVersions.set(url, (visitStatusVersions.get(url) || 0) + 1)
  visitStatusCache.delete(url)
}

function scheduleVisitStatusEnrichment(items, requestId) {
  const enrich = () => {
    if (requestId !== currentSearchRequestId) return
    items.forEach((item) => {
      getVisitStatus(item.url).then((isLocal) => {
        if (requestId !== currentSearchRequestId) return
        const row = renderedItems.get(item.url)
        if (row?.isConnected) updateSyncedBadge(row, isLocal)
      })
    })
  }

  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(enrich, { timeout: 500 })
  } else {
    setTimeout(enrich, 0)
  }
}

function showNotification(message) {
  // Remove any existing notifications
  const existingNotifications = document.querySelectorAll('.notification')
  existingNotifications.forEach((notification) => notification.remove())

  // Create and show the notification
  const notification = document.createElement('div')
  notification.className = 'notification'
  notification.textContent = message
  document.body.appendChild(notification)

  // Remove the notification after 2 seconds
  setTimeout(() => {
    notification.remove()
  }, 2000)
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown-menu.show').forEach((menu) => {
    menu.classList.remove('show')
  })
}

// Create a single dropdown menu that will be reused
let globalDropdownMenu = null

function createGlobalDropdownMenu() {
  if (globalDropdownMenu) return globalDropdownMenu

  const dropdownMenu = document.createElement('div')
  dropdownMenu.className = 'dropdown-menu'
  dropdownMenu.addEventListener('click', handleDropdownAction)
  document.body.appendChild(dropdownMenu)

  globalDropdownMenu = dropdownMenu
  return dropdownMenu
}

function updateActionBar() {
  const actionBar = document.getElementById('selection-action-bar')
  const searchBar = document.getElementById('search-bar-wrapper')
  const countSpan = document.getElementById('selected-count')

  if (selectedUrls.size > 0) {
    actionBar.style.display = 'flex'
    searchBar.style.display = 'none'
    countSpan.textContent = `${selectedUrls.size} selected`
  } else {
    actionBar.style.display = 'none'
    searchBar.style.display = 'flex'
  }
}

function clearSelection() {
  selectedUrls.clear()
  document.querySelectorAll('.history-item-checkbox').forEach((cb) => {
    cb.checked = false
  })
  lastCheckedCheckbox = null
  updateActionBar()
}

function removeRenderedItem(url) {
  const row = renderedItems.get(url)
  if (!row) return

  const group = row.closest('.date-group')
  row.remove()
  renderedItems.delete(url)
  renderedUrls.delete(url)
  selectedUrls.delete(url)
  invalidateVisitStatus(url)

  if (lastCheckedCheckbox && !lastCheckedCheckbox.isConnected) {
    lastCheckedCheckbox = null
  }

  if (group && !group.querySelector('.history-item')) {
    dateGroups.delete(group.dataset.dateKey)
    group.remove()
  }
}

function handleDropdownAction(event) {
  const actionElement = event.target.closest('.dropdown-item')
  if (!actionElement || !globalDropdownMenu?.contains(actionElement)) return

  event.stopPropagation()
  const url = globalDropdownMenu.dataset.url
  const item = renderedItems.get(url)?.historyItem
  if (!url || !item) {
    closeAllDropdowns()
    return
  }

  switch (actionElement.dataset.action) {
    case 'more-from-site': {
      const searchInput = document.querySelector('.search-bar input')
      searchInput.value = getHostname(url)
      performSearch()
      break
    }
    case 'remove':
      chrome.history.deleteUrl({ url }, () => {
        removeRenderedItem(url)
        showNotification('Removed from history')
      })
      break
    case 'copy':
      navigator.clipboard
        .writeText(url)
        .then(() => showNotification('URL copied to clipboard'))
        .catch((error) => {
          console.error('Could not copy URL: ', error)
          showNotification('Failed to copy URL')
        })
      break
  }

  closeAllDropdowns()
}

function openHistoryItemMenu(menuButton, item) {
  const dropdownMenu = createGlobalDropdownMenu()
  dropdownMenu.dataset.url = item.url
  dropdownMenu.innerHTML = `
    <div class="dropdown-item" data-action="more-from-site">More from this site</div>
    <div class="dropdown-item" data-action="remove">Remove from history</div>
    <div class="dropdown-item" data-action="copy">Copy URL</div>
  `

  closeAllDropdowns()
  dropdownMenu.classList.add('show')

  const menuRect = menuButton.getBoundingClientRect()
  const dropdownRect = dropdownMenu.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const preferredLeft = menuRect.right - dropdownRect.width

  dropdownMenu.style.top = `${menuRect.bottom + 4}px`
  dropdownMenu.style.left = `${Math.max(
    10,
    Math.min(preferredLeft, viewportWidth - dropdownRect.width - 10)
  )}px`

  if (menuRect.bottom + dropdownRect.height > viewportHeight) {
    dropdownMenu.style.top = `${menuRect.top - dropdownRect.height - 4}px`
  }
}

function deleteSelectedItems() {
  if (selectedUrls.size === 0) return

  const urlsToDelete = Array.from(selectedUrls)
  const deletePromises = urlsToDelete.map((url) => {
    return new Promise((resolve) => {
      chrome.history.deleteUrl({ url }, resolve)
    })
  })

  Promise.all(deletePromises).then(() => {
    urlsToDelete.forEach(removeRenderedItem)

    showNotification(`Deleted ${urlsToDelete.length} item(s)`)
    clearSelection()

    // If page is empty, load more
    const content = document.getElementById('content')
    if (content.children.length === 0) {
      hasMoreHistory = true
      loadMoreHistory(currentSearchRequestId)
    }
  })
}

function handleCheckboxClick(e, checkbox, url) {
  if (e.shiftKey && lastCheckedCheckbox) {
    const checkboxes = Array.from(document.querySelectorAll('.history-item-checkbox'))
    const start = checkboxes.indexOf(lastCheckedCheckbox)
    const end = checkboxes.indexOf(checkbox)

    if (start !== -1 && end !== -1) {
      const min = Math.min(start, end)
      const max = Math.max(start, end)
      const targetCheckedState = checkbox.checked

      for (let i = min; i <= max; i++) {
        const cb = checkboxes[i]
        const parentRow = cb.closest('.history-item')
        if (parentRow) {
          const itemUrl = parentRow.getAttribute('data-url')
          cb.checked = targetCheckedState
          if (targetCheckedState) {
            selectedUrls.add(itemUrl)
          } else {
            selectedUrls.delete(itemUrl)
          }
        }
      }
    }
  } else {
    if (checkbox.checked) {
      selectedUrls.add(url)
    } else {
      selectedUrls.delete(url)
    }
  }

  lastCheckedCheckbox = checkbox
  updateActionBar()
}

function updateSyncedBadge(row, isLocal) {
  const title = row.querySelector('.title')
  const existingBadge = title?.querySelector('.synced-badge')

  if (isLocal || !title) {
    existingBadge?.remove()
    return
  }
  if (existingBadge) return

  const syncedBadge = document.createElement('span')
  syncedBadge.className = 'synced-badge'
  syncedBadge.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" style="vertical-align: middle;">
      <path fill-rule="evenodd" d="M4 6h13v9H4V6zm15 2h3v10h-3V8zM2 4c0-1.1.9-2 2-2h13c1.1 0 2 .9 2 2v2h3c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2h-3c-1.1 0-2-.9-2-2v-1H4c-1.1 0-2-.9-2-2V4z"/>
    </svg>
  `
  title.appendChild(syncedBadge)
}

function createHistoryItem(item) {
  const div = document.createElement('div')
  div.className = 'history-item'
  div.setAttribute('data-url', item.url)
  div.historyItem = item

  // Prepend Checkbox
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'history-item-checkbox'
  checkbox.checked = selectedUrls.has(item.url)
  div.appendChild(checkbox)

  const favicon = document.createElement('img')
  favicon.className = 'favicon'
  favicon.loading = 'lazy'
  favicon.decoding = 'async'
  favicon.src = getFaviconUrl(item.url)
  favicon.onerror = () => {
    const domain = getHostname(item.url)
    const fallbackUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
    if (favicon.src !== fallbackUrl) {
      favicon.src = fallbackUrl
    } else {
      favicon.src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="gray"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'
    }
  }

  const details = document.createElement('div')
  details.className = 'item-details'

  const title = document.createElement('div')
  title.className = 'title'

  const titleText = document.createElement('span')
  titleText.className = 'title-text'
  titleText.textContent = item.title || getHostname(item.url)
  title.appendChild(titleText)

  const url = document.createElement('div')
  url.className = 'url'
  url.textContent = item.url

  const time = document.createElement('div')
  time.className = 'time'
  time.textContent = formatTime(new Date(item.lastVisitTime))

  const menuButton = document.createElement('div')
  menuButton.className = 'menu-button'
  menuButton.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path>
    </svg>
  `

  details.appendChild(title)
  details.appendChild(url)
  div.appendChild(time)
  div.appendChild(favicon)
  div.appendChild(details)
  div.appendChild(menuButton)
  updateSyncedBadge(div, item.isLocal !== false)

  return div
}

function handleContentClick(event) {
  const row = event.target.closest('.history-item')
  if (!row) return

  const item = row.historyItem
  const checkbox = row.querySelector('.history-item-checkbox')
  if (!item || !checkbox) return

  if (event.target.closest('.menu-button')) {
    event.stopPropagation()
    openHistoryItemMenu(event.target.closest('.menu-button'), item)
    return
  }

  if (event.target.closest('.history-item-checkbox')) {
    event.stopPropagation()
    handleCheckboxClick(event, checkbox, item.url)
    return
  }

  if (event.target.closest('.item-details') || event.target.closest('.time')) {
    window.open(item.url, '_blank')
    return
  }

  checkbox.checked = !checkbox.checked
  handleCheckboxClick(event, checkbox, item.url)
}

function groupHistoryByDate(items) {
  const groups = new Map()

  items.forEach((item) => {
    const date = new Date(item.lastVisitTime)
    const dateKey = getDateKey(date)

    if (!groups.has(dateKey)) {
      groups.set(dateKey, {
        label: formatDate(date),
        items: [],
      })
    }
    groups.get(dateKey).items.push(item)
  })

  return groups
}

function renderHistoryItems(items, container) {
  const groups = groupHistoryByDate(items)
  const newGroups = document.createDocumentFragment()

  groups.forEach((group, dateKey) => {
    let targetGroup = dateGroups.get(dateKey)
    const isNewGroup = !targetGroup

    if (!targetGroup) {
      targetGroup = document.createElement('div')
      targetGroup.className = 'date-group'
      targetGroup.dataset.dateKey = dateKey

      const header = document.createElement('div')
      header.className = 'date-header'
      header.textContent = group.label
      targetGroup.appendChild(header)
      dateGroups.set(dateKey, targetGroup)
    }

    const rows = document.createDocumentFragment()
    group.items.forEach((item) => {
      if (renderedUrls.has(item.url)) return

      const cachedStatus = getCachedVisitStatus(item.url)
      if (cachedStatus !== undefined) item.isLocal = cachedStatus

      const row = createHistoryItem(item)
      renderedUrls.add(item.url)
      renderedItems.set(item.url, row)
      rows.appendChild(row)
    })
    targetGroup.appendChild(rows)

    if (isNewGroup) newGroups.appendChild(targetGroup)
  })

  container.appendChild(newGroups)
}

function rearmHistoryObserver() {
  if (!historyObserver || !hasMoreHistory) return
  const sentinel = document.getElementById('history-sentinel')
  historyObserver.unobserve(sentinel)
  requestAnimationFrame(() => historyObserver.observe(sentinel))
}

function finishHistoryLoad(items, requestId) {
  lastFetchedTime = items[items.length - 1].lastVisitTime - 1
  isLoading = false
  document.getElementById('loading').style.display = 'none'
  if (requestId === currentSearchRequestId) rearmHistoryObserver()
}

function loadMoreHistory(requestId) {
  if (isLoading || !hasMoreHistory) return

  isLoading = true
  const loading = document.getElementById('loading')
  loading.style.display = 'block'

  chrome.history.search(
    {
      text: searchQuery,
      startTime: 0,
      endTime: lastFetchedTime,
      maxResults: ITEMS_PER_PAGE,
    },
    (items) => {
      // Check if this request is stale
      if (requestId !== currentSearchRequestId) {
        return
      }

      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError)
        loading.style.display = 'none'
        isLoading = false
        return
      }

      if (!items || items.length < ITEMS_PER_PAGE) {
        hasMoreHistory = false
      }

      const content = document.getElementById('content')

      if (items && items.length > 0) {
        items.sort((a, b) => b.lastVisitTime - a.lastVisitTime)
        const localOnly = document.getElementById('local-only-checkbox').checked

        if (localOnly) {
          Promise.all(
            items.map((item) =>
              getVisitStatus(item.url, true).then((isLocal) => ({
                item,
                isLocal,
              }))
            )
          ).then((resolvedItems) => {
            if (requestId !== currentSearchRequestId) return

            const filteredItems = resolvedItems
              .filter(({ isLocal }) => isLocal)
              .map(({ item, isLocal }) => {
                item.isLocal = isLocal
                return item
              })

            if (filteredItems.length > 0) {
              renderHistoryItems(filteredItems, content)
            }
            finishHistoryLoad(items, requestId)
          })
        } else {
          if (requestId !== currentSearchRequestId) {
            return
          }

          renderHistoryItems(items, content)
          finishHistoryLoad(items, requestId)
          scheduleVisitStatusEnrichment(items, requestId)
        }
      } else {
        if (content.children.length === 0) {
          const noResults = document.createElement('div')
          noResults.className = 'no-results'
          noResults.textContent = searchQuery
            ? `No search results for "${searchQuery}"`
            : 'No history items found'
          content.appendChild(noResults)
        }
        isLoading = false
        loading.style.display = 'none'
      }
    }
  )
}

function performSearch() {
  const searchInput = document.querySelector('.search-bar input')
  searchQuery = searchInput.value.trim().toLowerCase()

  // Reset the time to current to start a fresh search
  lastFetchedTime = new Date().getTime()

  // Increment request ID to invalidate any conflicting previous searches
  currentSearchRequestId++

  // Reset loading, paging, and selection states so we can immediately start the new search
  isLoading = false
  hasMoreHistory = true
  lastCheckedCheckbox = null

  // Clear existing content
  const content = document.getElementById('content')
  content.innerHTML = ''
  renderedUrls.clear()
  renderedItems.clear()
  dateGroups.clear()
  closeAllDropdowns()

  // Show loading indicator
  const loading = document.getElementById('loading')
  loading.style.display = 'block'

  // Load history with the search query and passing the ID
  loadMoreHistory(currentSearchRequestId)
}

function getSyncedDevices(forceRefresh = false) {
  if (!chrome.sessions?.getDevices) {
    return Promise.reject(new Error('Sync and Sessions API are not available.'))
  }

  if (!forceRefresh && deviceCache?.devices && deviceCache.expiresAt > Date.now()) {
    return Promise.resolve(deviceCache.devices)
  }
  if (!forceRefresh && deviceCache?.promise) return deviceCache.promise

  const promise = new Promise((resolve, reject) => {
    chrome.sessions.getDevices({ maxResults: 10 }, (devices) => {
      if (chrome.runtime.lastError) {
        deviceCache = null
        reject(new Error(chrome.runtime.lastError.message))
        return
      }

      const resolvedDevices = devices || []
      deviceCache = {
        devices: resolvedDevices,
        expiresAt: Date.now() + DEVICE_CACHE_TTL_MS,
        promise: null,
      }
      resolve(resolvedDevices)
    })
  })

  deviceCache = { devices: null, expiresAt: 0, promise }
  return promise
}

function getDeviceIcon(device) {
  const name = (device.info || device.deviceName || '').toLowerCase()
  if (
    name.includes('phone') ||
    name.includes('mobile') ||
    name.includes('android') ||
    name.includes('iphone')
  ) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/></svg>`
  }
  if (name.includes('tablet') || name.includes('ipad')) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 0h-13C3.57 0 2 1.57 2 3.5v17C2 22.43 3.57 24 5.5 24h13c1.93 0 3.5-1.57 3.5-3.5v-17C22 1.57 20.43 0 18.5 0zm-13 2h13c.83 0 1.5.67 1.5 1.5v13.5H4V3.5C4 2.67 4.67 2 5.5 2zm13 20h-13c-.83 0-1.5-.67-1.5-1.5V19h16v1.5c0 .83-.67 1.5-1.5 1.5z"/></svg>`
  }
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h24v-3h-2V6c0-1.1-.9-2-2-2zM2 17V6h18v11H2zm10 1.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>`
}

function createDeviceTab(tab) {
  const tabItem = document.createElement('a')
  tabItem.className = 'device-tab-item'
  tabItem.href = tab.url
  tabItem.target = '_blank'

  const favicon = document.createElement('img')
  favicon.className = 'favicon'
  favicon.loading = 'lazy'
  favicon.decoding = 'async'
  favicon.src = getFaviconUrl(tab.url)
  // Image error handlers remain per image because each fallback depends on its URL.
  favicon.onerror = () => {
    const fallbackUrl = `https://www.google.com/s2/favicons?domain=${getHostname(tab.url)}&sz=32`
    if (favicon.src !== fallbackUrl) {
      favicon.src = fallbackUrl
    } else {
      favicon.src =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="gray"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'
    }
  }

  const details = document.createElement('div')
  details.className = 'device-tab-details'
  const title = document.createElement('div')
  title.className = 'device-tab-title'
  title.textContent = tab.title || getHostname(tab.url)
  const url = document.createElement('div')
  url.className = 'device-tab-url'
  url.textContent = tab.url
  details.append(title, url)
  tabItem.append(favicon, details)

  if (tab.lastActiveTime) {
    const time = document.createElement('div')
    time.className = 'device-tab-time'
    time.textContent = formatTime(new Date(tab.lastActiveTime))
    tabItem.appendChild(time)
  }
  return tabItem
}

function renderSyncedDevices(devices) {
  const otherDevicesDiv = document.getElementById('other-devices-view')
  otherDevicesDiv.innerHTML = ''
  if (devices.length === 0) {
    otherDevicesDiv.innerHTML =
      '<div class="no-results">No synced devices found. Make sure you are signed in and Sync is turned on.</div>'
    return
  }

  const devicesFragment = document.createDocumentFragment()
  devices.forEach((device) => {
    const deviceCard = document.createElement('div')
    deviceCard.className = 'device-card'
    const header = document.createElement('div')
    header.className = 'device-card-header'
    header.innerHTML = `${getDeviceIcon(device)} <span>${
      device.info || device.deviceName || 'Other Device'
    }</span>`
    deviceCard.appendChild(header)

    const tabs = device.sessions.flatMap((session) =>
      session.tab ? [session.tab] : session.window?.tabs || []
    )
    const tabsFragment = document.createDocumentFragment()
    tabs.forEach((tab) => {
      if (tab.url?.trim()) tabsFragment.appendChild(createDeviceTab(tab))
    })

    if (!tabsFragment.childNodes.length) {
      const emptyMessage = document.createElement('div')
      emptyMessage.className = 'no-results'
      emptyMessage.style.padding = '10px'
      emptyMessage.textContent = 'No open tabs'
      deviceCard.appendChild(emptyMessage)
    } else {
      deviceCard.appendChild(tabsFragment)
    }
    devicesFragment.appendChild(deviceCard)
  })
  otherDevicesDiv.appendChild(devicesFragment)
}

function loadOtherDevices(forceRefresh = false) {
  const otherDevicesDiv = document.getElementById('other-devices-view')
  otherDevicesDiv.innerHTML = '<div class="loading">Loading synced devices...</div>'

  getSyncedDevices(forceRefresh)
    .then(renderSyncedDevices)
    .catch((error) => {
      console.error(error)
      otherDevicesDiv.innerHTML = chrome.sessions?.getDevices
        ? '<div class="no-results">Error loading synced devices. Make sure Chrome Sync is enabled.</div>'
        : '<div class="no-results">Sync and Sessions API are not available.</div>'
    })
}

function debounceSearch(func, delay) {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(func, delay)
}

function setupHistoryObserver() {
  const sentinel = document.getElementById('history-sentinel')
  historyObserver = new IntersectionObserver(
    (entries) => {
      const historyVisible = document.getElementById('content').style.display !== 'none'
      if (historyVisible && entries.some((entry) => entry.isIntersecting)) {
        loadMoreHistory(currentSearchRequestId)
      }
    },
    { rootMargin: '1000px 0px' }
  )
  historyObserver.observe(sentinel)
}

document.addEventListener('DOMContentLoaded', () => {
  // Create the global dropdown menu
  createGlobalDropdownMenu()
  document.getElementById('content').addEventListener('click', handleContentClick)
  setupHistoryObserver()

  // Add search functionality
  const searchInput = document.querySelector('.search-bar input')
  const clearSearchBtn = document.getElementById('clear-search')

  searchInput.addEventListener('input', () => {
    if (searchInput.value.length > 0) {
      clearSearchBtn.style.display = 'flex'
    } else {
      clearSearchBtn.style.display = 'none'
    }
    debounceSearch(performSearch, 300)
  })

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = ''
    clearSearchBtn.style.display = 'none'
    performSearch()
    searchInput.focus()
  })

  // Add click event for the search icon
  const searchIcon = document.querySelector('.search-bar svg')
  searchIcon.addEventListener('click', performSearch)
  searchIcon.style.cursor = 'pointer'

  // Load initial history with initial ID
  loadMoreHistory(currentSearchRequestId)

  // Sidebar navigation switching
  const navHistory = document.getElementById('nav-history')
  const navOtherDevices = document.getElementById('nav-other-devices')
  const contentDiv = document.getElementById('content')
  const otherDevicesDiv = document.getElementById('other-devices-view')
  const searchContainer = document.querySelector('.search-container')
  const historySentinel = document.getElementById('history-sentinel')

  navHistory.addEventListener('click', () => {
    navHistory.classList.add('active')
    navOtherDevices.classList.remove('active')
    contentDiv.style.display = 'block'
    historySentinel.style.display = 'block'
    otherDevicesDiv.style.display = 'none'
    searchContainer.style.display = 'flex'
    checkDeviceFilterVisibility()
    // Refresh history
    performSearch()
  })

  navOtherDevices.addEventListener('click', () => {
    navHistory.classList.remove('active')
    navOtherDevices.classList.add('active')
    contentDiv.style.display = 'none'
    historySentinel.style.display = 'none'
    otherDevicesDiv.style.display = 'block'
    searchContainer.style.display = 'none'
    document.getElementById('filter-device-container').style.display = 'none'
    clearSelection()
    loadOtherDevices()
  })

  // Add click listener for Local Only Checkbox
  const localOnlyCheckbox = document.getElementById('local-only-checkbox')
  const isLocalOnly = localStorage.getItem('localOnlyHistory') === 'true'
  localOnlyCheckbox.checked = isLocalOnly

  localOnlyCheckbox.addEventListener('change', () => {
    localStorage.setItem('localOnlyHistory', localOnlyCheckbox.checked)
    performSearch()
  })

  // Action Bar event listeners
  document.getElementById('cancel-selection').addEventListener('click', clearSelection)
  document.getElementById('delete-selected').addEventListener('click', deleteSelectedItems)

  // Add click handler for "Delete browsing data"
  const deleteDataButton = document.getElementById('delete-data')
  deleteDataButton.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/clearBrowserData' })
  })

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-button') && !e.target.closest('.dropdown-menu')) {
      closeAllDropdowns()
    }
  })

  // Initial check for device filter visibility
  checkDeviceFilterVisibility()
})

function checkDeviceFilterVisibility() {
  const filterDeviceContainer = document.getElementById('filter-device-container')
  const navHistory = document.getElementById('nav-history')

  if (!navHistory || !navHistory.classList.contains('active')) {
    if (filterDeviceContainer) filterDeviceContainer.style.display = 'none'
    return
  }

  if (chrome.sessions?.getDevices) {
    getSyncedDevices()
      .then((devices) => {
        if (filterDeviceContainer) {
          filterDeviceContainer.style.display = devices.length > 0 ? 'flex' : 'none'
        }
      })
      .catch(() => {
        if (filterDeviceContainer) filterDeviceContainer.style.display = 'none'
      })
  } else {
    if (filterDeviceContainer) filterDeviceContainer.style.display = 'none'
  }
}

chrome.history.onVisited.addListener((item) => {
  if (!item.url) return
  invalidateVisitStatus(item.url)
  const row = renderedItems.get(item.url)
  if (row?.isConnected) {
    getVisitStatus(item.url).then((isLocal) => updateSyncedBadge(row, isLocal))
  }
})

chrome.history.onVisitRemoved.addListener((removed) => {
  if (removed.allHistory) {
    visitStatusCache.clear()
    visitStatusVersions.clear()
  } else {
    removed.urls.forEach(invalidateVisitStatus)
  }
})

chrome.sessions?.onChanged?.addListener(() => {
  deviceCache = null
})
