import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import puppeteer, { type Browser, type Metrics, type Page } from 'puppeteer'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WORKSPACE_ROOT = path.resolve(__dirname, '..')
const INVARIANT_ONLY = process.argv.includes('--invariants')
const PAGE_SIZE = 50
const SEARCH_TERM = 'benchmark-target'

const WORKLOADS = ['initial-render', 'infinite-scroll', 'search', 'local-only'] as const
type WorkloadName = (typeof WORKLOADS)[number]

const SAMPLE_METRICS = [
  'durationMs',
  'renderedItems',
  'expectedItems',
  'historySearchCalls',
  'getVisitsCalls',
  'maxConcurrentGetVisits',
  'getVisitsBeforeFirstRow',
  'rowEventListenerRegistrations',
  'fullDomDedupQueries',
  'windowScrollListeners',
  'Nodes',
  'JSEventListeners',
  'JSHeapUsedSize',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'TaskDuration',
] as const
type SampleMetric = (typeof SAMPLE_METRICS)[number]

interface WorkloadSample extends Record<SampleMetric, number> {
  workload: WorkloadName
}

interface Distribution {
  median: number
  p95: number
  min: number
  max: number
  spread: number
  mean: number
  standardDeviation: number
}

interface SizeResult {
  historySize: number
  searchMatches: number
  warmupRuns: number
  measuredRuns: number
  samples: Record<WorkloadName, WorkloadSample[]>
  summary: Record<WorkloadName, Record<SampleMetric, Distribution>>
}

interface ComparisonMetric {
  baselineMedian: number
  currentMedian: number
  changePercent: number | null
}

interface BenchmarkResult {
  schemaVersion: 2
  runId: string
  timestamp: string
  chromeVersion: string
  puppeteerVersion: string
  configuration: {
    historySizes: number[]
    warmupRuns: number
    measuredRuns: number
    workloads: readonly WorkloadName[]
    isolatedTemporaryProfiles: true
    locallySeededHistory: true
  }
  sizes: SizeResult[]
  comparison?: Record<string, Record<WorkloadName, Record<string, ComparisonMetric>>>
}

interface Snapshot {
  historySearchCalls: number
  getVisitsCalls: number
  maxConcurrentGetVisits: number
  getVisitsBeforeFirstRow: number
  rowEventListenerRegistrations: number
  fullDomDedupQueries: number
  windowScrollListeners: number
  metrics: Metrics
}

function parseHistorySizes(): number[] {
  const configured = process.env.PERF_ITEMS || process.env.PERF_SIZES
  if (!configured) return INVARIANT_ONLY ? [50, 250] : [50, 250, 1000]

  return [...new Set(configured.split(',').map((value) => Number(value.trim())))].sort(
    (a, b) => a - b
  )
}

function parsePositiveInteger(name: string, fallback: number, allowZero = false): number {
  const value = Number(process.env[name] ?? fallback)
  const minimum = allowZero ? 0 : 1
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`)
  }
  return value
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

function percentile(sorted: number[], percentage: number): number {
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)
  return sorted[index]
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length

  return {
    median: round(median),
    p95: round(percentile(sorted, 95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    spread: round(sorted[sorted.length - 1] - sorted[0]),
    mean: round(mean),
    standardDeviation: round(Math.sqrt(variance)),
  }
}

function summarizeSamples(
  samples: Record<WorkloadName, WorkloadSample[]>
): Record<WorkloadName, Record<SampleMetric, Distribution>> {
  return Object.fromEntries(
    WORKLOADS.map((workload) => [
      workload,
      Object.fromEntries(
        SAMPLE_METRICS.map((metric) => [
          metric,
          distribution(samples[workload].map((sample) => sample[metric])),
        ])
      ),
    ])
  ) as Record<WorkloadName, Record<SampleMetric, Distribution>>
}

function assertInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invariant failed: ${message}`)
}

function createRunId(timestamp: string): string {
  return `${timestamp.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

function createImmutableResultPath(requestedPath: string | undefined, runId: string): string {
  const defaultDirectory = path.join(WORKSPACE_ROOT, '.performance-results')
  if (!requestedPath) {
    const prefix = INVARIANT_ONLY ? 'invariants' : 'benchmark'
    return path.join(defaultDirectory, `${prefix}-${runId}.json`)
  }

  const resolved = path.resolve(WORKSPACE_ROOT, requestedPath)
  const extension = path.extname(resolved)
  if (!extension) {
    const prefix = INVARIANT_ONLY ? 'invariants' : 'benchmark'
    return path.join(resolved, `${prefix}-${runId}.json`)
  }

  const filename = path.basename(resolved, extension)
  return path.join(path.dirname(resolved), `${filename}-${runId}${extension}`)
}

function writeImmutableResult(resultPath: string, benchmark: BenchmarkResult): void {
  fs.mkdirSync(path.dirname(resultPath), { recursive: true })
  fs.writeFileSync(resultPath, JSON.stringify(benchmark, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
  })
}

async function startHistoryServer(): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    })
    response.end('<!doctype html><title>Benchmark page</title><p>Benchmark page</p>')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine benchmark server address')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      ),
  }
}

async function seedHistory(browser: Browser, baseUrl: string, count: number): Promise<void> {
  const page = await browser.newPage()
  try {
    for (let index = 0; index < count; index++) {
      const category = index % 10 === 0 ? SEARCH_TERM : 'benchmark-regular'
      await page.goto(`${baseUrl}/${category}-${index}`, { waitUntil: 'domcontentloaded' })
    }
  } finally {
    await page.close()
  }
}

async function instrumentHistoryCalls(page: Page, initialLocalOnly = false): Promise<string[]> {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.evaluateOnNewDocument((localOnly) => {
    const root = globalThis as typeof globalThis & {
      __performanceBenchmark?: {
        historySearchCalls: number
        getVisitsCalls: number
        activeGetVisits: number
        maxConcurrentGetVisits: number
        getVisitsBeforeFirstRow: number
        rowEventListenerRegistrations: number
        fullDomDedupQueries: number
        windowScrollListeners: number
      }
      chrome?: {
        history?: {
          search?: (...args: unknown[]) => unknown
          getVisits?: (...args: unknown[]) => unknown
        }
      }
    }

    if (localOnly) localStorage.setItem('localOnlyHistory', 'true')
    else localStorage.removeItem('localOnlyHistory')
    root.__performanceBenchmark = {
      historySearchCalls: 0,
      getVisitsCalls: 0,
      activeGetVisits: 0,
      maxConcurrentGetVisits: 0,
      getVisitsBeforeFirstRow: 0,
      rowEventListenerRegistrations: 0,
      fullDomDedupQueries: 0,
      windowScrollListeners: 0,
    }

    const addEventListener = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      if (type === 'click' && this instanceof Element && this.classList.contains('history-item')) {
        root.__performanceBenchmark!.rowEventListenerRegistrations++
      }
      if (type === 'scroll' && this === window) {
        root.__performanceBenchmark!.windowScrollListeners++
      }
      return addEventListener.call(this, type, listener, options)
    }

    const querySelector = Document.prototype.querySelector
    Document.prototype.querySelector = function <E extends Element = Element>(
      selectors: string
    ): E | null {
      if (selectors.includes('.history-item[data-url=')) {
        root.__performanceBenchmark!.fullDomDedupQueries++
      }
      return querySelector.call(this, selectors) as E | null
    }

    const historyApi = root.chrome?.history
    if (!historyApi?.search || !historyApi.getVisits) return

    const search = historyApi.search.bind(historyApi)
    const getVisits = historyApi.getVisits.bind(historyApi)

    historyApi.search = (...args: unknown[]) => {
      root.__performanceBenchmark!.historySearchCalls++
      return search(...args)
    }
    historyApi.getVisits = (...args: unknown[]) => {
      root.__performanceBenchmark!.getVisitsCalls++
      root.__performanceBenchmark!.activeGetVisits++
      root.__performanceBenchmark!.maxConcurrentGetVisits = Math.max(
        root.__performanceBenchmark!.maxConcurrentGetVisits,
        root.__performanceBenchmark!.activeGetVisits
      )
      if (!document.querySelector('.history-item')) {
        root.__performanceBenchmark!.getVisitsBeforeFirstRow++
      }

      const callbackIndex = args.findIndex((argument) => typeof argument === 'function')
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => unknown
        args[callbackIndex] = (...callbackArgs: unknown[]) => {
          root.__performanceBenchmark!.activeGetVisits--
          return callback(...callbackArgs)
        }
      }
      return getVisits(...args)
    }
  }, initialLocalOnly)

  return pageErrors
}

async function snapshot(page: Page): Promise<Snapshot> {
  const [calls, metrics] = await Promise.all([
    page.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __performanceBenchmark?: {
          historySearchCalls: number
          getVisitsCalls: number
          maxConcurrentGetVisits: number
          getVisitsBeforeFirstRow: number
          rowEventListenerRegistrations: number
          fullDomDedupQueries: number
          windowScrollListeners: number
        }
      }
      return (
        root.__performanceBenchmark || {
          historySearchCalls: 0,
          getVisitsCalls: 0,
          maxConcurrentGetVisits: 0,
          getVisitsBeforeFirstRow: 0,
          rowEventListenerRegistrations: 0,
          fullDomDedupQueries: 0,
          windowScrollListeners: 0,
        }
      )
    }),
    page.metrics(),
  ])

  return {
    ...calls,
    metrics,
  }
}

async function settlePage(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )

  let previousCalls = -1
  let stableSamples = 0
  for (let attempt = 0; attempt < 10 && stableSamples < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const calls = await page.evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __performanceBenchmark?: { getVisitsCalls: number }
      }
      return root.__performanceBenchmark?.getVisitsCalls ?? 0
    })
    if (calls === previousCalls) stableSamples++
    else stableSamples = 0
    previousCalls = calls
  }

  await page.evaluate(() => {
    const root = globalThis as typeof globalThis & { gc?: () => void }
    root.gc?.()
  })
}

async function waitForItems(page: Page, expectedItems: number): Promise<void> {
  await page.waitForFunction(
    (count) => document.querySelectorAll('.history-item').length >= count,
    { timeout: 20_000 },
    expectedItems
  )
}

async function loadAllItems(page: Page, expectedItems: number): Promise<void> {
  while (true) {
    const renderedItems = await page.$$eval('.history-item', (items) => items.length)
    if (renderedItems >= expectedItems) return

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForFunction(
      (previousCount) => document.querySelectorAll('.history-item').length > previousCount,
      { timeout: 20_000 },
      renderedItems
    )
  }
}

function buildSample(
  workload: WorkloadName,
  durationMs: number,
  renderedItems: number,
  expectedItems: number,
  before: Snapshot,
  after: Snapshot
): WorkloadSample {
  const durationDelta = (key: keyof Metrics): number =>
    Math.max(0, Number(after.metrics[key] ?? 0) - Number(before.metrics[key] ?? 0))

  return {
    workload,
    durationMs: round(durationMs),
    renderedItems,
    expectedItems,
    historySearchCalls: after.historySearchCalls - before.historySearchCalls,
    getVisitsCalls: after.getVisitsCalls - before.getVisitsCalls,
    maxConcurrentGetVisits: after.maxConcurrentGetVisits,
    getVisitsBeforeFirstRow: after.getVisitsBeforeFirstRow - before.getVisitsBeforeFirstRow,
    rowEventListenerRegistrations:
      after.rowEventListenerRegistrations - before.rowEventListenerRegistrations,
    fullDomDedupQueries: after.fullDomDedupQueries - before.fullDomDedupQueries,
    windowScrollListeners: after.windowScrollListeners - before.windowScrollListeners,
    Nodes: after.metrics.Nodes ?? 0,
    JSEventListeners: after.metrics.JSEventListeners ?? 0,
    JSHeapUsedSize: after.metrics.JSHeapUsedSize ?? 0,
    ScriptDuration: round(durationDelta('ScriptDuration')),
    LayoutDuration: round(durationDelta('LayoutDuration')),
    RecalcStyleDuration: round(durationDelta('RecalcStyleDuration')),
    TaskDuration: round(durationDelta('TaskDuration')),
  }
}

function assertStructuralCounters(
  sample: WorkloadSample,
  options: { deferredLocalStatus?: boolean } = {}
): void {
  assertInvariant(
    sample.rowEventListenerRegistrations === 0,
    `${sample.workload} must not register per-row click listeners`
  )
  assertInvariant(
    sample.fullDomDedupQueries === 0,
    `${sample.workload} must not query the full DOM for URL deduplication`
  )
  assertInvariant(
    sample.windowScrollListeners === 0,
    `${sample.workload} must not register a window scroll listener`
  )
  assertInvariant(
    sample.maxConcurrentGetVisits <= 6,
    `${sample.workload} exceeded bounded getVisits concurrency`
  )
  if (options.deferredLocalStatus) {
    assertInvariant(
      sample.getVisitsBeforeFirstRow === 0,
      `${sample.workload} must render before starting getVisits enrichment`
    )
  }
}

async function openInstrumentedPage(
  browser: Browser,
  initialLocalOnly = false
): Promise<{ page: Page; pageErrors: string[] }> {
  const page = await browser.newPage()
  const pageErrors = await instrumentHistoryCalls(page, initialLocalOnly)
  return { page, pageErrors }
}

async function runInitialRender(
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<WorkloadSample> {
  const expectedItems = Math.min(PAGE_SIZE, historySize)
  const { page, pageErrors } = await openInstrumentedPage(browser)

  try {
    const before = await snapshot(page)
    const startedAt = performance.now()
    await page.goto(`chrome-extension://${extensionId}/history.html`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForItems(page, expectedItems)
    const durationMs = performance.now() - startedAt
    await settlePage(page)

    const renderedItems = await page.$$eval('.history-item', (items) => items.length)
    const after = await snapshot(page)

    assertInvariant(
      renderedItems === expectedItems,
      `initial render expected ${expectedItems} rows`
    )
    assertInvariant(after.historySearchCalls >= 1, 'initial render must search history')
    assertInvariant(pageErrors.length === 0, `initial render page errors: ${pageErrors.join('; ')}`)

    const structure = await page.evaluate(() => {
      const group = document.querySelector('.date-group')
      const favicon = document.querySelector<HTMLImageElement>('.history-item .favicon')
      return {
        hasSentinel: Boolean(document.getElementById('history-sentinel')),
        contentVisibility: group ? getComputedStyle(group).contentVisibility : '',
        faviconLoading: favicon?.loading,
        faviconDecoding: favicon?.decoding,
      }
    })
    assertInvariant(structure.hasSentinel, 'history sentinel must exist')
    assertInvariant(structure.contentVisibility === 'auto', 'date groups need content-visibility')
    assertInvariant(structure.faviconLoading === 'lazy', 'history favicons must lazy-load')
    assertInvariant(structure.faviconDecoding === 'async', 'history favicons must decode async')

    const sample = buildSample(
      'initial-render',
      durationMs,
      renderedItems,
      expectedItems,
      before,
      after
    )
    assertStructuralCounters(sample, { deferredLocalStatus: true })
    return sample
  } finally {
    await page.close()
  }
}

async function runInfiniteScroll(
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<WorkloadSample> {
  const { page, pageErrors } = await openInstrumentedPage(browser)

  try {
    const before = await snapshot(page)
    const startedAt = performance.now()
    await page.goto(`chrome-extension://${extensionId}/history.html`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForItems(page, Math.min(PAGE_SIZE, historySize))
    await loadAllItems(page, historySize)
    const durationMs = performance.now() - startedAt
    await settlePage(page)

    const renderedItems = await page.$$eval('.history-item', (items) => items.length)
    const after = await snapshot(page)

    assertInvariant(renderedItems === historySize, `infinite scroll expected ${historySize} rows`)
    assertInvariant(
      pageErrors.length === 0,
      `infinite scroll page errors: ${pageErrors.join('; ')}`
    )

    const sample = buildSample(
      'infinite-scroll',
      durationMs,
      renderedItems,
      historySize,
      before,
      after
    )
    assertStructuralCounters(sample, { deferredLocalStatus: true })
    return sample
  } finally {
    await page.close()
  }
}

async function prepareInteractivePage(
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<{ page: Page; pageErrors: string[] }> {
  const opened = await openInstrumentedPage(browser)
  await opened.page.goto(`chrome-extension://${extensionId}/history.html`, {
    waitUntil: 'domcontentloaded',
  })
  await waitForItems(opened.page, Math.min(PAGE_SIZE, historySize))
  await settlePage(opened.page)
  return opened
}

async function runSearch(
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<WorkloadSample> {
  const expectedItems = Math.ceil(historySize / 10)
  const { page, pageErrors } = await prepareInteractivePage(browser, extensionId, historySize)

  try {
    const before = await snapshot(page)
    const startedAt = performance.now()
    await page.$eval(
      '.search-bar input',
      (input, value) => {
        const searchInput = input as HTMLInputElement
        searchInput.value = value
        searchInput.dispatchEvent(new InputEvent('input', { bubbles: true }))
      },
      SEARCH_TERM
    )
    await page.waitForFunction(
      ({ previousSearchCalls, minimumRows }) => {
        const root = globalThis as typeof globalThis & {
          __performanceBenchmark?: { historySearchCalls: number }
        }
        return (
          (root.__performanceBenchmark?.historySearchCalls ?? 0) > previousSearchCalls &&
          document.querySelectorAll('.history-item').length >= minimumRows
        )
      },
      { timeout: 20_000 },
      {
        previousSearchCalls: before.historySearchCalls,
        minimumRows: Math.min(PAGE_SIZE, expectedItems),
      }
    )
    await loadAllItems(page, expectedItems)
    const durationMs = performance.now() - startedAt
    await settlePage(page)

    const urls = await page.$$eval('.history-item', (items) =>
      items.map((item) => item.getAttribute('data-url') || '')
    )
    const after = await snapshot(page)

    assertInvariant(urls.length === expectedItems, `search expected ${expectedItems} rows`)
    assertInvariant(
      urls.every((url) => url.includes(SEARCH_TERM)),
      'search returned a non-matching URL'
    )
    assertInvariant(pageErrors.length === 0, `search page errors: ${pageErrors.join('; ')}`)

    const sample = buildSample('search', durationMs, urls.length, expectedItems, before, after)
    assertStructuralCounters(sample)
    return sample
  } finally {
    await page.close()
  }
}

async function runLocalOnly(
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<WorkloadSample> {
  const expectedItems = Math.min(PAGE_SIZE, historySize)
  const { page, pageErrors } = await prepareInteractivePage(browser, extensionId, historySize)

  try {
    const before = await snapshot(page)
    const startedAt = performance.now()
    await page.$eval('#local-only-checkbox', (checkbox) => (checkbox as HTMLInputElement).click())
    await page.waitForFunction(
      ({ previousSearchCalls, minimumRows }) => {
        const root = globalThis as typeof globalThis & {
          __performanceBenchmark?: { historySearchCalls: number }
        }
        const checkbox = document.querySelector<HTMLInputElement>('#local-only-checkbox')
        return (
          checkbox?.checked === true &&
          (root.__performanceBenchmark?.historySearchCalls ?? 0) > previousSearchCalls &&
          document.querySelectorAll('.history-item').length >= minimumRows
        )
      },
      { timeout: 20_000 },
      {
        previousSearchCalls: before.historySearchCalls,
        minimumRows: expectedItems,
      }
    )
    const durationMs = performance.now() - startedAt
    await settlePage(page)

    const [renderedItems, checked] = await Promise.all([
      page.$$eval('.history-item', (items) => items.length),
      page.$eval('#local-only-checkbox', (checkbox) => (checkbox as HTMLInputElement).checked),
    ])
    const after = await snapshot(page)

    assertInvariant(checked, 'local-only checkbox must remain enabled')
    assertInvariant(
      renderedItems === expectedItems,
      `local-only expected ${expectedItems} local rows`
    )
    assertInvariant(pageErrors.length === 0, `local-only page errors: ${pageErrors.join('; ')}`)

    const sample = buildSample(
      'local-only',
      durationMs,
      renderedItems,
      expectedItems,
      before,
      after
    )
    assertStructuralCounters(sample)
    return sample
  } finally {
    await page.close()
  }
}

async function verifyColdLocalOnlyFiltering(
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<void> {
  const expectedItems = Math.min(PAGE_SIZE, historySize)
  const { page, pageErrors } = await openInstrumentedPage(browser, true)

  try {
    await page.goto(`chrome-extension://${extensionId}/history.html`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForItems(page, expectedItems)
    await settlePage(page)

    const [renderedItems, checked, measured] = await Promise.all([
      page.$$eval('.history-item', (items) => items.length),
      page.$eval('#local-only-checkbox', (checkbox) => (checkbox as HTMLInputElement).checked),
      snapshot(page),
    ])

    assertInvariant(checked, 'cold local-only preference must be applied')
    assertInvariant(
      renderedItems === expectedItems,
      `cold local-only expected ${expectedItems} local rows`
    )
    assertInvariant(
      measured.getVisitsCalls >= expectedItems,
      'cold local-only filtering must resolve visit locality before rendering'
    )
    assertInvariant(
      pageErrors.length === 0,
      `cold local-only page errors: ${pageErrors.join('; ')}`
    )
  } finally {
    await page.close()
  }
}

async function verifyDelegatedInteractions(
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<void> {
  const { page, pageErrors } = await openInstrumentedPage(browser)

  try {
    await page.goto(`chrome-extension://${extensionId}/history.html`, {
      waitUntil: 'domcontentloaded',
    })
    await waitForItems(page, Math.min(PAGE_SIZE, historySize))

    await page.evaluate(() => {
      const checkboxes = document.querySelectorAll<HTMLInputElement>('.history-item-checkbox')
      checkboxes[0].click()
      checkboxes[2].dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          shiftKey: true,
        })
      )
    })
    const selectedCount = await page.$$eval(
      '.history-item-checkbox:checked',
      (checkboxes) => checkboxes.length
    )
    assertInvariant(selectedCount === 3, 'delegated shift-selection must select a row range')

    await page.click('#cancel-selection')
    assertInvariant(
      (await page.$$eval('.history-item-checkbox:checked', (items) => items.length)) === 0,
      'cancel selection must clear delegated checkbox state'
    )

    await page.$eval('.history-item .menu-button', (button) => (button as HTMLElement).click())
    assertInvariant(
      (await page.$$eval('.dropdown-menu.show .dropdown-item', (items) => items.length)) === 3,
      'delegated menu must expose all actions'
    )

    await page.$eval('.dropdown-menu [data-action="copy"]', (action) =>
      (action as HTMLElement).click()
    )
    await page.waitForSelector('.notification')

    await page.$eval('.history-item .menu-button', (button) => (button as HTMLElement).click())
    const rowsBeforeDelete = await page.$$eval('.history-item', (items) => items.length)
    await page.$eval('.dropdown-menu [data-action="remove"]', (action) =>
      (action as HTMLElement).click()
    )
    await page.waitForFunction(
      (previousRows) => document.querySelectorAll('.history-item').length === previousRows - 1,
      { timeout: 20_000 },
      rowsBeforeDelete
    )

    assertInvariant(
      pageErrors.length === 0,
      `delegated interaction page errors: ${pageErrors.join('; ')}`
    )
  } finally {
    await page.close()
  }
}

async function runWorkload(
  workload: WorkloadName,
  browser: Browser,
  extensionId: string,
  historySize: number
): Promise<WorkloadSample> {
  switch (workload) {
    case 'initial-render':
      return runInitialRender(browser, extensionId, historySize)
    case 'infinite-scroll':
      return runInfiniteScroll(browser, extensionId, historySize)
    case 'search':
      return runSearch(browser, extensionId, historySize)
    case 'local-only':
      return runLocalOnly(browser, extensionId, historySize)
  }
}

async function runSizeSuite(
  baseUrl: string,
  historySize: number,
  warmupRuns: number,
  measuredRuns: number
): Promise<{ chromeVersion: string; result: SizeResult }> {
  const browser = await puppeteer.launch({
    args: ['--js-flags=--expose-gc'],
    channel: 'chrome',
    enableExtensions: true,
    headless: true,
  })

  try {
    const extensionId = await browser.installExtension(WORKSPACE_ROOT)
    await seedHistory(browser, baseUrl, historySize)

    if (INVARIANT_ONLY) {
      await verifyColdLocalOnlyFiltering(browser, extensionId, historySize)
    }

    for (let run = 1; run <= warmupRuns; run++) {
      console.log(`  Warm-up ${run}/${warmupRuns}`)
      for (const workload of WORKLOADS) {
        await runWorkload(workload, browser, extensionId, historySize)
      }
    }

    const samples = Object.fromEntries(
      WORKLOADS.map((workload) => [workload, []])
    ) as unknown as Record<WorkloadName, WorkloadSample[]>

    for (let run = 1; run <= measuredRuns; run++) {
      console.log(`  Measured run ${run}/${measuredRuns}`)
      for (const workload of WORKLOADS) {
        const sample = await runWorkload(workload, browser, extensionId, historySize)
        samples[workload].push(sample)
        console.log(
          `    ${workload}: ${sample.durationMs} ms, ` +
            `${sample.getVisitsCalls} getVisits, ${sample.renderedItems} rows`
        )
      }
    }

    if (INVARIANT_ONLY) {
      await verifyDelegatedInteractions(browser, extensionId, historySize)
    }

    return {
      chromeVersion: await browser.version(),
      result: {
        historySize,
        searchMatches: Math.ceil(historySize / 10),
        warmupRuns,
        measuredRuns,
        samples,
        summary: summarizeSamples(samples),
      },
    }
  } finally {
    await browser.close()
  }
}

function createComparison(
  baseline: BenchmarkResult,
  current: BenchmarkResult
): BenchmarkResult['comparison'] {
  const selectedMetrics: SampleMetric[] = [
    'durationMs',
    'getVisitsCalls',
    'JSEventListeners',
    'Nodes',
    'JSHeapUsedSize',
    'ScriptDuration',
    'LayoutDuration',
    'TaskDuration',
  ]
  const comparison: NonNullable<BenchmarkResult['comparison']> = {}

  for (const currentSize of current.sizes) {
    const baselineSize = baseline.sizes.find(
      (candidate) => candidate.historySize === currentSize.historySize
    )
    if (!baselineSize) continue

    comparison[String(currentSize.historySize)] = Object.fromEntries(
      WORKLOADS.map((workload) => [
        workload,
        Object.fromEntries(
          selectedMetrics.map((metric) => {
            const baselineMedian = baselineSize.summary[workload][metric].median
            const currentMedian = currentSize.summary[workload][metric].median
            return [
              metric,
              {
                baselineMedian,
                currentMedian,
                changePercent:
                  baselineMedian === 0
                    ? null
                    : round(((currentMedian - baselineMedian) / baselineMedian) * 100),
              },
            ]
          })
        ),
      ])
    ) as Record<WorkloadName, Record<string, ComparisonMetric>>
  }

  return comparison
}

function printSummary(result: BenchmarkResult): void {
  console.log('\nBenchmark summary (median / p95 / spread):')
  for (const size of result.sizes) {
    console.log(`  ${size.historySize} history items`)
    for (const workload of WORKLOADS) {
      const timing = size.summary[workload].durationMs
      const calls = size.summary[workload].getVisitsCalls
      console.log(
        `    ${workload}: ${timing.median} / ${timing.p95} / ${timing.spread} ms; ` +
          `${calls.median} median getVisits`
      )
    }
  }
}

async function main(): Promise<void> {
  const historySizes = parseHistorySizes()
  assertInvariant(
    historySizes.every((size) => Number.isInteger(size) && size >= PAGE_SIZE),
    `history sizes must be integers of at least ${PAGE_SIZE}`
  )

  const warmupRuns = INVARIANT_ONLY ? 0 : parsePositiveInteger('PERF_WARMUP_RUNS', 1, true)
  const measuredRuns = INVARIANT_ONLY ? 1 : parsePositiveInteger('PERF_RUNS', 5)
  const comparisonPath = process.env.PERF_COMPARE
    ? path.resolve(WORKSPACE_ROOT, process.env.PERF_COMPARE)
    : null

  const server = await startHistoryServer()
  const sizes: SizeResult[] = []
  let chromeVersion = ''

  try {
    for (const historySize of historySizes) {
      console.log(`\nHistory size: ${historySize}`)
      const measured = await runSizeSuite(server.baseUrl, historySize, warmupRuns, measuredRuns)
      chromeVersion = measured.chromeVersion
      sizes.push(measured.result)
    }
  } finally {
    await server.close()
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(WORKSPACE_ROOT, 'node_modules/puppeteer/package.json'), 'utf8')
  )
  const timestamp = new Date().toISOString()
  const runId = createRunId(timestamp)
  const benchmark: BenchmarkResult = {
    schemaVersion: 2,
    runId,
    timestamp,
    chromeVersion,
    puppeteerVersion: packageJson.version,
    configuration: {
      historySizes,
      warmupRuns,
      measuredRuns,
      workloads: WORKLOADS,
      isolatedTemporaryProfiles: true,
      locallySeededHistory: true,
    },
    sizes,
  }

  if (comparisonPath) {
    const baseline = JSON.parse(fs.readFileSync(comparisonPath, 'utf8')) as BenchmarkResult
    assertInvariant(baseline.schemaVersion === 2, 'comparison baseline must use schema version 2')
    benchmark.comparison = createComparison(baseline, benchmark)
  }

  printSummary(benchmark)

  if (INVARIANT_ONLY) {
    console.log('\nAll performance correctness invariants passed.')
  }

  const resultPath = createImmutableResultPath(process.env.PERF_OUTPUT, runId)
  writeImmutableResult(resultPath, benchmark)
  console.log(`Wrote immutable result ${path.relative(WORKSPACE_ROOT, resultPath)}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
