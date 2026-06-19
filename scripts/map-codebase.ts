import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const WORKSPACE_ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(WORKSPACE_ROOT, 'docs')

if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true })
}

// Helpers
function getFilesRecursive(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList
  const files = fs.readdirSync(dir)
  for (const file of files) {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      if (
        file !== 'node_modules' &&
        file !== '.git' &&
        file !== '.vscode' &&
        file !== 'docs' &&
        file !== 'scripts'
      ) {
        getFilesRecursive(filePath, fileList)
      }
    } else {
      fileList.push(filePath)
    }
  }
  return fileList
}

console.log('Mapping codebase...')

// 1. Gather all files in the workspace (excluding build artifacts, git, packages, etc)
const allWorkspaceFiles = getFilesRecursive(WORKSPACE_ROOT)
  .map((f) => path.relative(WORKSPACE_ROOT, f).replace(/\\/g, '/'))
  .filter(
    (f) =>
      ![
        'package.json',
        'package-lock.json',
        '.gitignore',
        '.prettierrc',
        'README.md',
        'release_notes.md',
      ].includes(f)
  )

// 2. Read manifest.json to discover entry points
const manifestPath = path.join(WORKSPACE_ROOT, 'manifest.json')
const entryPoints = new Set<string>()

if (fs.existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    entryPoints.add('manifest.json')

    // Background script
    if (manifest.background && manifest.background.service_worker) {
      entryPoints.add(manifest.background.service_worker)
    }

    // HTML overrides
    if (manifest.chrome_url_overrides) {
      for (const key of Object.keys(manifest.chrome_url_overrides)) {
        entryPoints.add(manifest.chrome_url_overrides[key])
      }
    }

    // Icons
    if (manifest.icons) {
      for (const key of Object.keys(manifest.icons)) {
        entryPoints.add(manifest.icons[key])
      }
    }
  } catch (err) {
    console.error('Error parsing manifest.json:', err)
  }
}

// 3. Resolve imports/references from HTML/JS files
const dependencyMap = new Map<string, string[]>()

for (const relPath of allWorkspaceFiles) {
  const absPath = path.join(WORKSPACE_ROOT, relPath)
  const deps: string[] = []

  if (relPath.endsWith('.html')) {
    try {
      const content = fs.readFileSync(absPath, 'utf8')
      // Extract <script src="...">
      const scriptRegex = /<script\s+[^>]*src=["']([^"']+)["']/g
      let match
      while ((match = scriptRegex.exec(content)) !== null) {
        const cleanSource = match[1].split('?')[0]
        const target = path.join(path.dirname(relPath), cleanSource).replace(/\\/g, '/')
        deps.push(target)
      }

      // Extract stylesheet/icon links
      const cssRegex = /<link\s+[^>]*href=["']([^"']+)["']/g
      while ((match = cssRegex.exec(content)) !== null) {
        if (!match[1].startsWith('http') && !match[1].startsWith('//')) {
          const cleanSource = match[1].split('?')[0]
          const target = path.join(path.dirname(relPath), cleanSource).replace(/\\/g, '/')
          deps.push(target)
        }
      }
    } catch (err) {
      console.error(`Error reading ${relPath}:`, err)
    }
  }

  dependencyMap.set(relPath, deps)
}

// 4. BFS Reachability Analysis
const visited = new Set<string>()
const queue: string[] = []

for (const entry of entryPoints) {
  if (allWorkspaceFiles.includes(entry)) {
    queue.push(entry)
    visited.add(entry)
  }
}

while (queue.length > 0) {
  const current = queue.shift()!
  const deps = dependencyMap.get(current) || []
  for (const dep of deps) {
    if (allWorkspaceFiles.includes(dep) && !visited.has(dep)) {
      visited.add(dep)
      queue.push(dep)
    }
  }
}

const activeFiles: string[] = []
const orphanedFiles: string[] = []

for (const file of allWorkspaceFiles) {
  if (visited.has(file)) {
    activeFiles.push(file)
  } else {
    orphanedFiles.push(file)
  }
}

// 5. Output Reports
const outputMap = {
  timestamp: new Date().toISOString(),
  entrypoints: Array.from(entryPoints),
  activeFilesCount: activeFiles.length,
  orphanedFilesCount: orphanedFiles.length,
  activeFiles: activeFiles.sort(),
  orphanedFiles: orphanedFiles.sort(),
  dependencies: Object.fromEntries(dependencyMap),
}

// Write json map
fs.writeFileSync(path.join(DOCS_DIR, 'codebase_map.json'), JSON.stringify(outputMap, null, 2))
console.log('Wrote docs/codebase_map.json')

// Write CODEBASE_GRAPH.md
let md = `# Codebase Map & Graph\n\n`
md += `*Last updated: ${new Date().toLocaleString()}*\n\n`

md += `## 🖥️ Chrome Extension Reachability Analysis\n\n`
md += `* **Entrypoints:** ${Array.from(entryPoints)
  .map((e) => `\`${e}\``)
  .join(', ')}\n`
md += `* **Active/Reachable Files:** ${activeFiles.length}\n`
md += `* **Orphaned / Unused Files:** ${orphanedFiles.length}\n\n`

md += `### Active Files\n`
for (const file of activeFiles.sort()) {
  md += `- [${file}](../${file})\n`
  const deps = dependencyMap.get(file) || []
  if (deps.length > 0) {
    for (const dep of deps) {
      md += `  - *References:* [${dep}](../${dep})\n`
    }
  }
}
md += `\n`

if (orphanedFiles.length > 0) {
  md += `### ⚠️ Orphaned / Unused Files\n`
  for (const file of orphanedFiles.sort()) {
    md += `- [${file}](../${file}) *(Not referenced anywhere)*\n`
  }
  md += `\n`
}

fs.writeFileSync(path.join(DOCS_DIR, 'CODEBASE_GRAPH.md'), md)
console.log('Wrote docs/CODEBASE_GRAPH.md')

console.log('Codebase mapping completed successfully!')
process.exit(0)
