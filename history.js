const ITEMS_PER_PAGE = 50
const FAVICON_FALLBACK =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="gray"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>'

let lastFetchedTime = Date.now()
let isLoading = false
let searchQuery = ''
let currentSearchRequestId = 0
let hasMoreHistory = true
let searchTimeout
let lastCheckedCheckbox = null
let hasSyncedDevices = null // null = unknown, otherwise cached successful getDevices result
let scrollSentinel = null

const selectedUrls = new Set() // URLs selected for bulk actions
const renderedUrls = new Set() // URLs currently in the DOM
const removedUrls = new Set() // URLs deleted this session; never re-render them
const dateGroups = new Map() // day key -> date group element
const itemElements = new Map() // url -> history item element

function formatDate(date) {
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

function formatRelativeTime(timestamp) {
  const diffMinutes = Math.round((Date.now() - timestamp) / 60000)
  if (diffMinutes < 1) return 'just now'
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (diffMinutes < 60) return rtf.format(-diffMinutes, 'minute')
  if (diffMinutes < 1440) return rtf.format(-Math.floor(diffMinutes / 60), 'hour')
  return rtf.format(-Math.floor(diffMinutes / 1440), 'day')
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
    return FAVICON_FALLBACK
  }
}

function attachFavicon(img, url) {
  img.className = 'favicon'
  img.loading = 'lazy'
  img.decoding = 'async'
  img.src = getFaviconUrl(url)
  // _favicon/ serves a default globe when a site has no icon, so failures are
  // rare; fall back to a local placeholder rather than any external service
  img.onerror = () => {
    img.onerror = null
    img.src = FAVICON_FALLBACK
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

function showNoResults(message) {
  const content = document.getElementById('content')
  const noResults = document.createElement('div')
  noResults.className = 'no-results'
  noResults.textContent =
    message || (searchQuery ? `No search results for "${searchQuery}"` : 'No history items found')
  content.appendChild(noResults)
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

async function deleteSelectedItems() {
  if (selectedUrls.size === 0) return

  const urlsToDelete = Array.from(selectedUrls)
  const results = await Promise.all(
    urlsToDelete.map(
      (url) =>
        new Promise((resolve) => {
          chrome.history.deleteUrl({ url }, () => {
            const failed = !!chrome.runtime.lastError
            if (failed) console.error(chrome.runtime.lastError)
            resolve({ url, ok: !failed })
          })
        })
    )
  )

  const okResults = results.filter((r) => r.ok)
  const failedCount = results.length - okResults.length

  // Only drop rows for URLs that were actually deleted
  // (removeHistoryItemByUrl also clears them from the selection)
  okResults.forEach((r) => removeHistoryItemByUrl(r.url))

  if (failedCount === 0) {
    showNotification(`Deleted ${results.length} item(s)`)
    clearSelection()
  } else {
    // Keep the failed items selected so they can be retried without reselecting
    if (okResults.length === 0) {
      showNotification('Failed to delete items')
    } else {
      showNotification(`Deleted ${okResults.length} item(s), ${failedCount} failed`)
    }
    lastCheckedCheckbox = null
    updateActionBar()
  }

  // If page is empty, load more
  const content = document.getElementById('content')
  if (content.children.length === 0) {
    hasMoreHistory = true
    loadMoreHistory(currentSearchRequestId)
  }
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
          const itemUrl = parentRow.dataset.url
          cb.checked = targetCheckedState
          if (targetCheckedState) {
            selectedUrls.add(itemUrl)
          } else {
            selectedUrls.delete(itemUrl)
          }
        }
      }

      lastCheckedCheckbox = checkbox
      updateActionBar()
      return
    }
  }

  // Plain click, or a shift-click whose anchor row no longer exists — the
  // native click already toggled the checkbox, so keep the selection in sync
  if (checkbox.checked) {
    selectedUrls.add(url)
  } else {
    selectedUrls.delete(url)
  }
  lastCheckedCheckbox = checkbox
  updateActionBar()
}

function createSyncedBadge() {
  const syncedBadge = document.createElement('span')
  syncedBadge.className = 'synced-badge'
  syncedBadge.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" style="vertical-align: middle;">
      <path fill-rule="evenodd" d="M4 6h13v9H4V6zm15 2h3v10h-3V8zM2 4c0-1.1.9-2 2-2h13c1.1 0 2 .9 2 2v2h3c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2h-3c-1.1 0-2-.9-2-2v-1H4c-1.1 0-2-.9-2-2V4z"/>
    </svg>
  `
  return syncedBadge
}

function addSyncedBadge(url) {
  const element = itemElements.get(url)
  if (!element) return
  const title = element.querySelector('.title')
  if (title && !title.querySelector('.synced-badge')) {
    title.appendChild(createSyncedBadge())
  }
}

function createHistoryItem(item) {
  const div = document.createElement('div')
  div.className = 'history-item'
  div.dataset.url = item.url

  // Prepend Checkbox
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = 'history-item-checkbox'
  checkbox.checked = selectedUrls.has(item.url)
  div.appendChild(checkbox)

  const favicon = document.createElement('img')
  attachFavicon(favicon, item.url)

  const details = document.createElement('div')
  details.className = 'item-details'

  const title = document.createElement('div')
  title.className = 'title'

  const titleText = document.createElement('span')
  titleText.className = 'title-text'
  titleText.textContent = item.title || getHostname(item.url)
  title.appendChild(titleText)

  if (item.isLocal === false) {
    title.appendChild(createSyncedBadge())
  }

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

  renderedUrls.add(item.url)
  itemElements.set(item.url, div)

  return div
}

function getDayKey(date) {
  // Local-time day key, so grouping and ordering never depend on locale formatting
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
}

function dayKeyToDate(dayKey) {
  const year = Math.floor(dayKey / 10000)
  const month = Math.floor((dayKey % 10000) / 100)
  const day = dayKey % 100
  return new Date(year, month - 1, day)
}

function ensureDateGroup(dayKey, container) {
  const key = String(dayKey)
  let group = dateGroups.get(key)
  if (group) return group

  group = document.createElement('div')
  group.className = 'date-group'
  group.dataset.dayKey = key

  const header = document.createElement('div')
  header.className = 'date-header'
  header.textContent = formatDate(dayKeyToDate(dayKey))
  group.appendChild(header)

  // Keep groups ordered newest -> oldest
  let nextGroup = null
  for (const child of container.children) {
    if (child.classList.contains('date-group') && Number(child.dataset.dayKey) < dayKey) {
      nextGroup = child
      break
    }
  }
  if (nextGroup) {
    container.insertBefore(group, nextGroup)
  } else {
    container.appendChild(group)
  }

  dateGroups.set(key, group)
  return group
}

function renderHistoryItems(items) {
  // Refresh group headers so "Today"/"Yesterday" stay correct if the page
  // stays open across midnight
  for (const [key, group] of dateGroups) {
    group.querySelector('.date-header').textContent = formatDate(dayKeyToDate(Number(key)))
  }

  let added = 0
  const byDay = new Map()
  for (const item of items) {
    // Skip rows the user already deleted this session — a page's search
    // snapshot can predate the delete and would otherwise resurrect them
    if (removedUrls.has(item.url) || renderedUrls.has(item.url)) continue
    added++
    const key = String(getDayKey(new Date(item.lastVisitTime)))
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(item)
  }

  const container = document.getElementById('content')
  const sortedKeys = Array.from(byDay.keys()).sort((a, b) => Number(b) - Number(a))

  for (const key of sortedKeys) {
    const group = ensureDateGroup(Number(key), container)
    const fragment = document.createDocumentFragment()
    for (const item of byDay.get(key)) {
      fragment.appendChild(createHistoryItem(item))
    }
    group.appendChild(fragment)

    // Drop the group again if every item turned out to be a duplicate
    if (group.querySelectorAll('.history-item').length === 0) {
      dateGroups.delete(key)
      group.remove()
    }
  }

  return added
}

function removeHistoryItemByUrl(url) {
  removedUrls.add(url)
  const element = itemElements.get(url)
  if (!element) return

  const group = element.closest('.date-group')
  const wasSelected = selectedUrls.delete(url)

  element.remove()
  itemElements.delete(url)
  renderedUrls.delete(url)

  if (group && group.querySelectorAll('.history-item').length === 0) {
    dateGroups.delete(group.dataset.dayKey)
    group.remove()
  }

  if (wasSelected) updateActionBar()
}

function resetContentView() {
  document.getElementById('content').innerHTML = ''
  renderedUrls.clear()
  removedUrls.clear()
  dateGroups.clear()
  itemElements.clear()
}

// Resolve which items were visited on this device (synced items have isLocal === false)
function resolveLocalStatus(items) {
  return Promise.all(
    items.map(
      (item) =>
        new Promise((resolve) => {
          let settled = false
          const done = (isLocal) => {
            if (!settled) {
              settled = true
              resolve({ item, isLocal })
            }
          }

          // Safety net: treat the visit as local if the API never calls back,
          // so a hung lookup can never wedge pagination
          const timeout = setTimeout(() => done(true), 10000)
          chrome.history.getVisits({ url: item.url }, (visits) => {
            clearTimeout(timeout)
            if (chrome.runtime.lastError) {
              console.error(chrome.runtime.lastError)
              done(true)
              return
            }
            let latest = null
            for (const visit of visits || []) {
              if (!latest || visit.visitTime > latest.visitTime) latest = visit
            }
            done(latest ? latest.isLocal !== false : true)
          })
        })
    )
  )
}

function isHistoryVisible() {
  return document.getElementById('content').style.display !== 'none'
}

function loadMoreHistory(requestId) {
  if (isLoading || !hasMoreHistory) return

  isLoading = true
  const loading = document.getElementById('loading')
  loading.style.display = 'block'

  // Release the loading state; idempotent, safe on every exit path
  const settle = () => {
    isLoading = false
    loading.style.display = 'none'
  }

  // Keep loading while the sentinel is still inside the observer's 1000px
  // lookahead — the observer alone can miss it, since it only fires when the
  // sentinel crosses the boundary. Never chain loads while the history view
  // is hidden (e.g. while the "Tabs from other devices" list is showing).
  const finish = () => {
    if (
      hasMoreHistory &&
      requestId === currentSearchRequestId &&
      isHistoryVisible() &&
      scrollSentinel &&
      scrollSentinel.getBoundingClientRect().top < window.innerHeight + 1000
    ) {
      loadMoreHistory(requestId)
    }
  }

  chrome.history.search(
    {
      text: searchQuery,
      startTime: 0,
      endTime: lastFetchedTime,
      maxResults: ITEMS_PER_PAGE,
    },
    async (items) => {
      // Check if this request is stale — a newer search owns the loading state
      if (requestId !== currentSearchRequestId) {
        return
      }

      try {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError)
          settle()
          return
        }

        if (!items || items.length < ITEMS_PER_PAGE) {
          hasMoreHistory = false
        }

        const content = document.getElementById('content')

        if (!items || items.length === 0) {
          if (content.children.length === 0) {
            showNoResults()
          }
          settle()
          return
        }

        // Sort items by date (newest first)
        items.sort((a, b) => b.lastVisitTime - a.lastVisitTime)

        // Inclusive cursor: the next page must still see items sharing the
        // boundary item's timestamp (redirect chains record several URLs in
        // the same millisecond). Dedup prevents double renders; the guard
        // below forces progress if an entire page shares one timestamp.
        const previousEndTime = lastFetchedTime
        lastFetchedTime = items[items.length - 1].lastVisitTime

        const localOnly = document.getElementById('local-only-checkbox').checked
        let added

        if (localOnly) {
          // Filtering by device needs the visit data before rendering
          const resolvedItems = await resolveLocalStatus(items)
          if (requestId !== currentSearchRequestId) return
          added = renderHistoryItems(resolvedItems.filter((r) => r.isLocal).map((r) => r.item))
        } else {
          // Render immediately; synced badges resolve in the background
          added = renderHistoryItems(items)
        }

        // Guarantee pagination progress past an all-one-timestamp page
        if (added === 0 && lastFetchedTime === previousEndTime) {
          lastFetchedTime = previousEndTime - 1
        }

        // Make the empty state explicit when the device filter removed every
        // remaining result, instead of leaving a silent blank view
        if (!hasMoreHistory && added === 0 && content.children.length === 0) {
          showNoResults(localOnly ? 'No history from this device found' : undefined)
        }

        settle()
        finish()

        if (!localOnly) {
          resolveLocalStatus(items)
            .then((resolvedItems) => {
              if (requestId !== currentSearchRequestId) return
              for (const { item, isLocal } of resolvedItems) {
                item.isLocal = isLocal
                if (!isLocal) addSyncedBadge(item.url)
              }
            })
            .catch((err) => console.error('Synced-badge lookup failed:', err))
        }
      } catch (err) {
        console.error('Loading history failed:', err)
        if (requestId === currentSearchRequestId) {
          settle()
        }
      }
    }
  )
}

function performSearch() {
  const searchInput = document.querySelector('.search-bar input')
  searchQuery = searchInput.value.trim().toLowerCase()

  // Reset the time to current to start a fresh search
  lastFetchedTime = Date.now()

  // Increment request ID to invalidate any conflicting previous searches
  currentSearchRequestId++

  // Reset loading, paging, and selection states so we can immediately start the new search
  isLoading = false
  hasMoreHistory = true
  // Drop any selection from the previous results — rows are about to change,
  // and a stale action bar would hide the search bar over unrelated results
  clearSelection()
  lastCheckedCheckbox = null

  resetContentView()

  // Show loading indicator
  const loading = document.getElementById('loading')
  loading.style.display = 'block'

  // Load history with the search query and passing the ID
  loadMoreHistory(currentSearchRequestId)
}

function openItemMenu(menuButton, url) {
  // Get or create the global dropdown menu
  const dropdownMenu = createGlobalDropdownMenu()

  // Clear previous content
  dropdownMenu.innerHTML = ''

  // Add menu items
  const moreFromSite = document.createElement('div')
  moreFromSite.className = 'dropdown-item'
  moreFromSite.textContent = 'More from this site'
  moreFromSite.addEventListener('click', (e) => {
    e.stopPropagation()
    const searchInput = document.querySelector('.search-bar input')
    searchInput.value = getHostname(url)
    performSearch()
    closeAllDropdowns()
  })

  const removeFromHistory = document.createElement('div')
  removeFromHistory.className = 'dropdown-item'
  removeFromHistory.textContent = 'Remove from history'
  removeFromHistory.addEventListener('click', (e) => {
    e.stopPropagation()
    chrome.history.deleteUrl({ url }, () => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError)
        showNotification('Failed to remove from history')
        return
      }
      removeHistoryItemByUrl(url)
      showNotification('Removed from history')
    })
    closeAllDropdowns()
  })

  const copyUrl = document.createElement('div')
  copyUrl.className = 'dropdown-item'
  copyUrl.textContent = 'Copy URL'
  copyUrl.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard
      .writeText(url)
      .then(() => {
        showNotification('URL copied to clipboard')
      })
      .catch((err) => {
        console.error('Could not copy URL: ', err)
        showNotification('Failed to copy URL')
      })
    closeAllDropdowns()
  })

  dropdownMenu.appendChild(moreFromSite)
  dropdownMenu.appendChild(removeFromHistory)
  dropdownMenu.appendChild(copyUrl)

  // Close any open dropdowns
  closeAllDropdowns()

  // Show the dropdown
  dropdownMenu.classList.add('show')

  // Position the dropdown below the clicked menu button, aligned to its right
  const menuRect = menuButton.getBoundingClientRect()
  const dropdownRect = dropdownMenu.getBoundingClientRect()

  dropdownMenu.style.top = `${menuRect.bottom + 4}px`
  dropdownMenu.style.left = `${menuRect.right - dropdownRect.width}px`

  // Make sure the dropdown doesn't go off-screen
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight

  const currentLeft = parseFloat(dropdownMenu.style.left)

  if (currentLeft < 0) {
    dropdownMenu.style.left = '10px'
  } else if (currentLeft + dropdownRect.width > viewportWidth) {
    dropdownMenu.style.left = `${viewportWidth - dropdownRect.width - 10}px`
  }

  if (menuRect.bottom + dropdownRect.height > viewportHeight) {
    dropdownMenu.style.top = `${menuRect.top - dropdownRect.height - 4}px`
  }
}

// Device group menu: "Open all" opens every synced tab from the device in
// background tabs; "Hide for now" collapses the group without forgetting it
function openDeviceMenu(anchor, tabs, group, header) {
  const dropdownMenu = createGlobalDropdownMenu()
  dropdownMenu.innerHTML = ''

  const openAll = document.createElement('div')
  openAll.className = 'dropdown-item'
  openAll.textContent = 'Open all'
  openAll.addEventListener('click', (e) => {
    e.stopPropagation()
    tabs.forEach((tab) => chrome.tabs.create({ url: tab.url, active: false }))
    showNotification(`Opened ${tabs.length} tab(s)`)
    closeAllDropdowns()
  })

  const hideForNow = document.createElement('div')
  hideForNow.className = 'dropdown-item'
  hideForNow.textContent = 'Hide for now'
  hideForNow.addEventListener('click', (e) => {
    e.stopPropagation()
    group.classList.add('collapsed')
    header.setAttribute('aria-expanded', 'false')
    closeAllDropdowns()
  })

  dropdownMenu.appendChild(openAll)
  dropdownMenu.appendChild(hideForNow)

  closeAllDropdowns()
  dropdownMenu.classList.add('show')

  // Position below the kebab, aligned to its right edge
  const anchorRect = anchor.getBoundingClientRect()
  const menuRect = dropdownMenu.getBoundingClientRect()
  dropdownMenu.style.top = `${anchorRect.bottom + 4}px`
  dropdownMenu.style.left = `${anchorRect.right - menuRect.width}px`

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const currentLeft = parseFloat(dropdownMenu.style.left)
  if (currentLeft < 0) {
    dropdownMenu.style.left = '10px'
  } else if (currentLeft + menuRect.width > viewportWidth) {
    dropdownMenu.style.left = `${viewportWidth - menuRect.width - 10}px`
  }
  if (anchorRect.bottom + menuRect.height > viewportHeight) {
    dropdownMenu.style.top = `${anchorRect.top - menuRect.height - 4}px`
  }
}

// One delegated listener handles clicks for every history item, including
// items added later, instead of attaching listeners per item
function onContentClick(e) {
  const itemElement = e.target.closest('.history-item')
  if (!itemElement) return

  const url = itemElement.dataset.url
  const checkbox = itemElement.querySelector('.history-item-checkbox')

  if (e.target.closest('.menu-button')) {
    openItemMenu(e.target.closest('.menu-button'), url)
  } else if (e.target.closest('.history-item-checkbox')) {
    handleCheckboxClick(e, checkbox, url)
  } else if (e.target.closest('.item-details') || e.target.closest('.time')) {
    window.open(url, '_blank', 'noopener')
  } else {
    checkbox.dispatchEvent(
      new MouseEvent('click', {
        shiftKey: e.shiftKey,
        bubbles: true,
      })
    )
  }
}

// Filter synced-tab rows across all device groups (the search bar on the
// "Tabs from other devices" view). Collapsed groups are temporarily expanded
// while a query is active and restored when it is cleared.
function filterDeviceTabs(rawQuery) {
  const query = rawQuery.trim().toLowerCase()
  const groups = document.getElementById('other-devices-view').querySelectorAll('.device-group')
  groups.forEach((group) => {
    const header = group.querySelector('.device-group-header')

    if (!query) {
      group.style.display = ''
      group.querySelectorAll('.device-tab-item').forEach((row) => {
        row.style.display = ''
      })
      if (group.dataset.wasCollapsed === '1') {
        group.classList.add('collapsed')
        header.setAttribute('aria-expanded', 'false')
      }
      delete group.dataset.wasCollapsed
      return
    }

    let anyVisible = false
    group.querySelectorAll('.device-tab-item').forEach((row) => {
      const haystack = `${row.textContent} ${row.getAttribute('href') || ''}`.toLowerCase()
      const match = haystack.includes(query)
      row.style.display = match ? '' : 'none'
      if (match) anyVisible = true
    })

    if (anyVisible) {
      if (group.dataset.wasCollapsed === undefined) {
        group.dataset.wasCollapsed = group.classList.contains('collapsed') ? '1' : ''
      }
      group.classList.remove('collapsed')
      header.setAttribute('aria-expanded', 'true')
    }
    group.style.display = anyVisible ? '' : 'none'
  })
}

function loadOtherDevices() {
  const otherDevicesDiv = document.getElementById('other-devices-view')
  otherDevicesDiv.innerHTML = '<div class="loading">Loading synced devices...</div>'

  if (!chrome.sessions || !chrome.sessions.getDevices) {
    otherDevicesDiv.innerHTML =
      '<div class="no-results">Sync and Sessions API are not available.</div>'
    return
  }

  chrome.sessions.getDevices({ maxResults: 25 }, (devices) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError)
      otherDevicesDiv.innerHTML =
        '<div class="no-results">Error loading synced devices. Make sure Chrome Sync is enabled.</div>'
      return
    }

    hasSyncedDevices = devices && devices.length > 0
    otherDevicesDiv.innerHTML = ''

    if (!devices || devices.length === 0) {
      otherDevicesDiv.innerHTML =
        '<div class="no-results">No synced devices found. Make sure you are signed in and Sync is turned on.</div>'
      return
    }

    devices.forEach((device) => {
      // Collect usable tabs from sessions. Chrome hides url/title on synced
      // Tab objects without the tabs permission, and placeholder entries
      // without a URL would render as empty rows — so they don't count.
      const tabs = []
      device.sessions.forEach((session) => {
        if (session.tab && session.tab.url && session.tab.url.trim() !== '') {
          tabs.push(session.tab)
        } else if (session.window && session.window.tabs) {
          session.window.tabs.forEach((tab) => {
            if (tab.url && tab.url.trim() !== '') tabs.push(tab)
          })
        }
      })

      const group = document.createElement('div')
      group.className = 'device-group'

      const header = document.createElement('div')
      header.className = 'device-group-header'
      header.setAttribute('role', 'button')
      header.setAttribute('aria-expanded', 'true')

      // Select icon based on device type info or name
      const nameLower = (device.info || device.deviceName || '').toLowerCase()
      let iconSvg = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h24v-3h-2V6c0-1.1-.9-2-2-2zM2 17V6h18v11H2zm10 1.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
        </svg>
      ` // Default laptop
      if (
        nameLower.includes('phone') ||
        nameLower.includes('mobile') ||
        nameLower.includes('android') ||
        nameLower.includes('iphone')
      ) {
        iconSvg = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z"/>
          </svg>
        ` // Phone
      } else if (nameLower.includes('tablet') || nameLower.includes('ipad')) {
        iconSvg = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.5 0h-13C3.57 0 2 1.57 2 3.5v17C2 22.43 3.57 24 5.5 24h13c1.93 0 3.5-1.57 3.5-3.5v-17C22 1.57 20.43 0 18.5 0zm-13 2h13c.83 0 1.5.67 1.5 1.5v13.5H4V3.5C4 2.67 4.67 2 5.5 2zm13 20h-13c-.83 0-1.5-.67-1.5-1.5V19h16v1.5c0 .83-.67 1.5-1.5 1.5z"/>
          </svg>
        ` // Tablet
      }

      const iconSpan = document.createElement('span')
      iconSpan.className = 'device-icon'
      iconSpan.innerHTML = iconSvg // static SVG markup
      header.appendChild(iconSpan)

      const nameSpan = document.createElement('span')
      nameSpan.textContent = device.info || device.deviceName || 'Other Device'
      header.appendChild(nameSpan)

      const latestActive = tabs.reduce(
        (latest, tab) =>
          tab.lastActiveTime && (!latest || tab.lastActiveTime > latest)
            ? tab.lastActiveTime
            : latest,
        0
      )
      if (latestActive) {
        const timeSpan = document.createElement('span')
        timeSpan.className = 'device-relative-time'
        timeSpan.textContent = `– ${formatRelativeTime(latestActive)}`
        header.appendChild(timeSpan)
      }

      const kebab = document.createElement('span')
      kebab.className = 'device-kebab'
      kebab.setAttribute('role', 'button')
      kebab.setAttribute('aria-label', 'Device options')
      kebab.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"></path></svg>`
      kebab.addEventListener('click', (e) => {
        e.stopPropagation()
        openDeviceMenu(kebab, tabs, group, header)
      })
      header.appendChild(kebab)

      const chevron = document.createElement('span')
      chevron.className = 'collapse-chevron'
      chevron.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>`
      header.appendChild(chevron)

      header.addEventListener('click', () => {
        const collapsed = group.classList.toggle('collapsed')
        header.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
      })

      group.appendChild(header)

      const tabsWrap = document.createElement('div')
      tabsWrap.className = 'device-group-tabs'

      if (tabs.length === 0) {
        const emptyMsg = document.createElement('div')
        emptyMsg.className = 'no-results'
        emptyMsg.style.padding = '10px 16px'
        emptyMsg.textContent = 'No open tabs'
        tabsWrap.appendChild(emptyMsg)
      } else {
        tabs.forEach((tab) => {
          const tabItem = document.createElement('a')
          tabItem.className = 'device-tab-item'
          tabItem.href = tab.url
          tabItem.target = '_blank'
          tabItem.rel = 'noopener noreferrer'
          tabItem.title = tab.url

          const favicon = document.createElement('img')
          attachFavicon(favicon, tab.url)

          const titleSpan = document.createElement('span')
          titleSpan.className = 'device-tab-title'
          titleSpan.textContent = tab.title || getHostname(tab.url)

          tabItem.appendChild(favicon)
          tabItem.appendChild(titleSpan)
          tabsWrap.appendChild(tabItem)
        })
      }

      group.appendChild(tabsWrap)
      otherDevicesDiv.appendChild(group)
    })
  })
}

function debounceSearch(func, delay) {
  clearTimeout(searchTimeout)
  searchTimeout = setTimeout(func, delay)
}

document.addEventListener('DOMContentLoaded', () => {
  // Create the global dropdown menu
  createGlobalDropdownMenu()

  const content = document.getElementById('content')

  // Add search functionality
  const searchInput = document.querySelector('.search-bar input')
  const clearSearchBtn = document.getElementById('clear-search')

  searchInput.addEventListener('input', () => {
    if (searchInput.value.length > 0) {
      clearSearchBtn.style.display = 'flex'
    } else {
      clearSearchBtn.style.display = 'none'
    }
    if (navOtherDevices.classList.contains('active')) {
      filterDeviceTabs(searchInput.value)
    } else {
      debounceSearch(performSearch, 300)
    }
  })

  clearSearchBtn.addEventListener('click', () => {
    searchInput.value = ''
    clearSearchBtn.style.display = 'none'
    if (navOtherDevices.classList.contains('active')) {
      filterDeviceTabs('')
    } else {
      performSearch()
    }
    searchInput.focus()
  })

  // Add click event for the search icon
  const searchIcon = document.querySelector('.search-bar svg')
  searchIcon.addEventListener('click', () => {
    if (navOtherDevices.classList.contains('active')) {
      filterDeviceTabs(searchInput.value)
    } else {
      performSearch()
    }
  })
  searchIcon.style.cursor = 'pointer'

  // Delegated click handling for all history items
  content.addEventListener('click', onContentClick)

  // Load initial history with initial ID
  loadMoreHistory(currentSearchRequestId)

  // Infinite scroll: load more when the sentinel comes near the viewport
  const sentinel = document.createElement('div')
  sentinel.id = 'scroll-sentinel'
  document.querySelector('.main-content').appendChild(sentinel)
  scrollSentinel = sentinel
  const loadMoreObserver = new IntersectionObserver(
    (entries) => {
      // Skip while the history list is hidden — the sentinel moves to the top
      // of the page otherwise and would load history behind the devices view
      if (isHistoryVisible() && entries.some((entry) => entry.isIntersecting)) {
        loadMoreHistory(currentSearchRequestId)
      }
    },
    { rootMargin: '1000px' }
  )
  loadMoreObserver.observe(sentinel)

  // Sidebar navigation switching
  const navHistory = document.getElementById('nav-history')
  const navOtherDevices = document.getElementById('nav-other-devices')
  const otherDevicesDiv = document.getElementById('other-devices-view')
  const searchContainer = document.querySelector('.search-container')

  navHistory.addEventListener('click', () => {
    navHistory.classList.add('active')
    navOtherDevices.classList.remove('active')
    content.style.display = 'block'
    otherDevicesDiv.style.display = 'none'
    searchContainer.style.display = 'flex'
    checkDeviceFilterVisibility()
    // Refresh history
    performSearch()
  })

  navOtherDevices.addEventListener('click', () => {
    navHistory.classList.remove('active')
    navOtherDevices.classList.add('active')
    content.style.display = 'none'
    otherDevicesDiv.style.display = 'block'
    // Native keeps the search bar visible here; it filters synced tabs
    searchContainer.style.display = 'flex'
    document.getElementById('filter-device-container').style.display = 'none'
    clearSelection()
    loadOtherDevices()
    filterDeviceTabs(searchInput.value)
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

  const apply = (hasDevices) => {
    if (filterDeviceContainer) {
      // Keep the toggle reachable whenever the local-only filter is active,
      // so it can always be turned back off
      const localOnly = document.getElementById('local-only-checkbox').checked
      filterDeviceContainer.style.display = hasDevices || localOnly ? 'flex' : 'none'
    }
  }

  // Reuse the cached result instead of querying the sessions API on every nav
  if (hasSyncedDevices !== null) {
    apply(hasSyncedDevices)
    return
  }

  if (chrome.sessions && chrome.sessions.getDevices) {
    chrome.sessions.getDevices({ maxResults: 1 }, (devices) => {
      if (chrome.runtime.lastError) {
        // Don't cache failures — Sync may not be ready yet; retry on next nav
        console.error(chrome.runtime.lastError)
        apply(false)
        return
      }
      hasSyncedDevices = devices && devices.length > 0
      apply(hasSyncedDevices)
    })
  } else {
    hasSyncedDevices = false
    apply(false)
  }
}
