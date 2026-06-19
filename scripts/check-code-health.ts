import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const WORKSPACE_ROOT = path.resolve(__dirname, '..')
const DOCS_DIR = path.join(WORKSPACE_ROOT, 'docs')

if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true })
}

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
}

console.log(`${colors.bright}${colors.cyan}Starting AST-Based Code Health Check...${colors.reset}`)

// 1. Find all JS and TS source files
function getSourceFiles(dir: string, fileList: string[] = []): string[] {
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
        getSourceFiles(filePath, fileList)
      }
    } else if (/\.(js|ts)$/.test(file)) {
      fileList.push(filePath)
    }
  }
  return fileList
}

const sourceFilePaths = getSourceFiles(WORKSPACE_ROOT).map((f) => path.resolve(f))
console.log(`Indexed ${sourceFilePaths.length} source files.`)

// 2. Initialize AST Parsing
interface FunctionDef {
  name: string
  line: number
  filePath: string
  node: ts.Node
}

const functionDeclarations: FunctionDef[] = []
const identifierReferences = new Map<string, { count: number; locations: string[] }>()

for (const filePath of sourceFilePaths) {
  const relPath = path.relative(WORKSPACE_ROOT, filePath).replace(/\\/g, '/')
  const content = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2022, true)

  // Track function declaration nodes to avoid counting their names as references
  const declarationNodes = new Set<ts.Node>()

  // Pass 1: Find all function definitions and variables holding functions
  function findDefinitions(node: ts.Node) {
    // e.g. function foo() {}
    if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.name.getStart()).line + 1
      functionDeclarations.push({
        name: node.name.text,
        line,
        filePath: relPath,
        node: node.name,
      })
      declarationNodes.add(node.name)
    }

    // e.g. const foo = () => {} or const foo = function() {}
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.name.getStart()).line + 1
        functionDeclarations.push({
          name: node.name.text,
          line,
          filePath: relPath,
          node: node.name,
        })
        declarationNodes.add(node.name)
      }
    }

    ts.forEachChild(node, findDefinitions)
  }
  findDefinitions(sourceFile)

  // Pass 2: Count all identifier references (skipping the definition nodes themselves)
  function countReferences(node: ts.Node) {
    if (ts.isIdentifier(node) && !declarationNodes.has(node)) {
      const name = node.text
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      let refs = identifierReferences.get(name)
      if (!refs) {
        refs = { count: 0, locations: [] }
        identifierReferences.set(name, refs)
      }
      refs.count++
      refs.locations.push(`${relPath}:${line}`)
    }
    ts.forEachChild(node, countReferences)
  }
  countReferences(sourceFile)
}

// 3. Find Unused Functions
const unusedFunctions: FunctionDef[] = []

for (const func of functionDeclarations) {
  const refs = identifierReferences.get(func.name)
  // Standard callbacks used by Chrome/Browser lifecycles might have 0 internal references but are entry points.
  // However, event listeners or background script tasks should still be flagged if totally unreferenced.
  if (!refs || refs.count === 0) {
    unusedFunctions.push(func)
  }
}

// 4. Output Results
const unusedList = unusedFunctions.map((f) => ({
  name: f.name,
  file: f.filePath,
  line: f.line,
}))

const reportJson = {
  timestamp: new Date().toISOString(),
  unusedFunctionsCount: unusedList.length,
  unusedFunctions: unusedList,
}

fs.writeFileSync(
  path.join(DOCS_DIR, 'code_health_report.json'),
  JSON.stringify(reportJson, null, 2)
)
console.log('Wrote docs/code_health_report.json')

// Write CODE_HEALTH.md
let md = `# Code Health Report\n\n`
md += `*Last updated: ${new Date().toLocaleString()}*\n\n`

md += `## ⚠️ Unused Javascript Functions (AST-Based)\n\n`
if (unusedFunctions.length === 0) {
  md += `✅ No unused functions detected. All declared functions are referenced in the codebase.\n\n`
} else {
  md += `The following functions are declared/defined but never referenced inside any of the script files:\n\n`
  md += `| File | Function Name | Line |\n`
  md += `| --- | --- | --- |\n`
  for (const f of unusedFunctions.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line
  )) {
    md += `| [\`${f.filePath}\`](../${f.filePath}) | \`${f.name}\` | [\`L${f.line}\`](../${f.filePath}#L${f.line}) |\n`
  }
  md += `\n`
}

fs.writeFileSync(path.join(DOCS_DIR, 'CODE_HEALTH.md'), md)
console.log('Wrote docs/CODE_HEALTH.md')

console.log(`${colors.green}Code health check completed successfully.${colors.reset}`)
process.exit(0)
