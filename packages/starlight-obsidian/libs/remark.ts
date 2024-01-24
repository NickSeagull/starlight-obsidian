import fs from 'node:fs'
import path from 'node:path'

import { toHtml } from 'hast-util-to-html'
import isAbsoluteUrl from 'is-absolute-url'
import type { BlockContent, Blockquote, Code, Image, Link, Parent, Root, RootContent } from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { toHast } from 'mdast-util-to-hast'
import { CONTINUE, SKIP, visit } from 'unist-util-visit'
import type { VFile } from 'vfile'
import yaml from 'yaml'

import type { StarlightObsidianConfig } from '..'

import { transformHtmlToString } from './html'
import { transformMarkdownToAST } from './markdown'
import {
  getObsidianRelativePath,
  isObsidianAsset,
  isObsidianBlockAnchor,
  parseObsidianFrontmatter,
  slugifyObsidianAnchor,
  slugifyObsidianPath,
  type ObsidianFrontmatter,
  type Vault,
  type VaultFile,
} from './obsidian'
import { extractPathAndAnchor, getExtension, isAnchor } from './path'
import { getStarlightCalloutType } from './starlight'

const highlightReplacementRegex = /==(?<highlight>(?:(?!==).)+)==/g
const commentReplacementRegex = /%%(?<comment>(?:(?!%%).)+)%%/gs
const wikilinkReplacementRegex = /!?\[\[(?<url>(?:(?![[\]|]).)+)(?:\|(?<maybeText>(?:(?![[\]|]).)+))?]]/g
const tagReplacementRegex = /(?:^|\s)#(?<tag>[\w/-]+)/g
const calloutRegex = /^\[!(?<type>\w+)][+-]? ?(?<title>.*)$/

const asideDelimiter = ':::'

export function remarkStarlightObsidian() {
  return async function transformer(tree: Root, file: VFile) {
    handleReplacements(tree, file)
    await handleMermaid(tree, file)

    visit(tree, (node, index, parent) => {
      const context: VisitorContext = { file, index, parent }

      switch (node.type) {
        case 'math':
        case 'inlineMath': {
          return handleMath(context)
        }
        case 'link': {
          return handleLinks(node, context)
        }
        case 'image': {
          return handleImages(node, context)
        }
        case 'blockquote': {
          return handleBlockquotes(node, context)
        }
        default: {
          return CONTINUE
        }
      }
    })

    handleFrontmatter(tree, file)
  }
}

function handleFrontmatter(tree: Root, file: VFile) {
  let hasFrontmatter = false

  // The frontmatter is always at the root of the tree.
  for (const node of tree.children) {
    if (node.type !== 'yaml') {
      continue
    }

    hasFrontmatter = true
    node.value = getFrontmatterNodeValue(file, parseObsidianFrontmatter(node.value))
    break
  }

  if (!hasFrontmatter) {
    tree.children.unshift({ type: 'yaml', value: getFrontmatterNodeValue(file) })
  }
}

function handleReplacements(tree: Root, file: VFile) {
  findAndReplace(tree, [
    [
      highlightReplacementRegex,
      (_match: string, highlight: string) => ({
        type: 'html',
        value: `<mark class="sl-obs-highlight">${highlight}</mark>`,
      }),
    ],
    [commentReplacementRegex, null],
    [
      wikilinkReplacementRegex,
      (match: string, url: string, maybeText?: string) => {
        ensureTransformContext(file)

        let fileUrl: string
        let text = maybeText ?? url

        if (isAnchor(url)) {
          fileUrl = slugifyObsidianAnchor(url)
          text = maybeText ?? url.slice(isObsidianBlockAnchor(url) ? 2 : 1)
        } else {
          const [urlPath, urlAnchor] = extractPathAndAnchor(url)
          const matchingFile = file.data.files.find(
            (vaultFile) => vaultFile.stem === urlPath || vaultFile.fileName === urlPath,
          )

          switch (file.data.vault.options.linkFormat) {
            case 'relative': {
              fileUrl = getFileUrl(file.data.output, getRelativeFilePath(file, urlPath), urlAnchor)
              break
            }
            case 'absolute':
            case 'shortest': {
              fileUrl = getFileUrl(
                file.data.output,
                matchingFile ? getFilePathFromVaultFile(matchingFile, urlPath) : urlPath,
                urlAnchor,
              )
              break
            }
          }
        }

        if (match.startsWith('!')) {
          return {
            type: 'image',
            url: isMarkdownAsset(url, file) ? url : fileUrl,
            alt: text,
          }
        }

        return {
          children: [{ type: 'text', value: text }],
          type: 'link',
          url: fileUrl,
        }
      },
    ],
    [
      tagReplacementRegex,
      (_match: string, tag: string) => {
        // Tags with only numbers are not valid.
        // https://help.obsidian.md/Editing+and+formatting/Tags#Tag%20format
        if (/^\d+$/.test(tag)) {
          return false
        }

        return {
          type: 'html',
          value: ` <span class="sl-obs-tag">#${tag}</span>`,
        }
      },
    ],
  ])
}

function handleMath({ file }: VisitorContext) {
  file.data.includeKatexStyles = true
  return SKIP
}

function handleLinks(node: Link, { file }: VisitorContext) {
  ensureTransformContext(file)

  if (file.data.vault.options.linkSyntax === 'wikilink' || isAbsoluteUrl(node.url) || !file.dirname) {
    return SKIP
  }

  if (isAnchor(node.url)) {
    node.url = slugifyObsidianAnchor(node.url)
    return SKIP
  }

  const url = path.basename(decodeURIComponent(node.url))
  const [urlPath, urlAnchor] = extractPathAndAnchor(url)
  const matchingFile = file.data.files.find((vaultFile) => vaultFile.fileName === urlPath)

  if (!matchingFile) {
    return SKIP
  }

  switch (file.data.vault.options.linkFormat) {
    case 'relative': {
      node.url = getFileUrl(file.data.output, getRelativeFilePath(file, node.url), urlAnchor)
      break
    }
    case 'absolute':
    case 'shortest': {
      node.url = getFileUrl(file.data.output, getFilePathFromVaultFile(matchingFile, node.url), urlAnchor)
      break
    }
  }

  return SKIP
}

function handleImages(node: Image, context: VisitorContext) {
  const { file } = context

  ensureTransformContext(file)

  if (isAbsoluteUrl(node.url) || !file.dirname) {
    return SKIP
  }

  if (isMarkdownAsset(node.url, file)) {
    replaceNode(context, getMarkdownAssetNode(file, node.url))
    return SKIP
  }

  let fileUrl = node.url

  if (file.data.vault.options.linkSyntax !== 'wikilink') {
    switch (file.data.vault.options.linkFormat) {
      case 'relative': {
        fileUrl = getFileUrl(file.data.output, getRelativeFilePath(file, node.url))
        break
      }
      case 'absolute': {
        fileUrl = getFileUrl(file.data.output, slugifyObsidianPath(node.url))
        break
      }
      case 'shortest': {
        const url = path.basename(decodeURIComponent(node.url))
        const [urlPath] = extractPathAndAnchor(url)
        const matchingFile = file.data.files.find((vaultFile) => vaultFile.fileName === urlPath)

        if (!matchingFile) {
          break
        }

        fileUrl = getFileUrl(file.data.output, getFilePathFromVaultFile(matchingFile, node.url))
        break
      }
    }
  }

  if (isCustomAsset(node.url)) {
    replaceNode(context, getCustomAssetNode(fileUrl))

    return SKIP
  }

  node.url = fileUrl

  return SKIP
}

function handleBlockquotes(node: Blockquote, context: VisitorContext) {
  const [firstChild, ...otherChildren] = node.children

  if (firstChild?.type !== 'paragraph') {
    return SKIP
  }

  const [firstGrandChild, ...otherGrandChildren] = firstChild.children

  if (firstGrandChild?.type !== 'text') {
    return SKIP
  }

  const [firstLine, ...otherLines] = firstGrandChild.value.split('\n')

  if (!firstLine) {
    return SKIP
  }

  const match = firstLine.match(calloutRegex)

  const type = match?.groups?.['type']
  const title = match?.groups?.['title']

  if (!match || !type) {
    return SKIP
  }

  const asideTitle = title && title.length > 0 ? `[${title.trim()}]` : ''

  const aside: RootContent[] = [
    {
      type: 'paragraph',
      children: [
        {
          type: 'html',
          value: `${asideDelimiter}${getStarlightCalloutType(type)}${asideTitle}\n${otherLines.join('\n')}`,
        },
        ...otherGrandChildren,
        ...(otherChildren.length === 0 ? [{ type: 'html', value: `\n${asideDelimiter}` } satisfies RootContent] : []),
      ],
    },
  ]

  if (otherChildren.length > 0) {
    aside.push(...otherChildren, { type: 'html', value: asideDelimiter })
  }

  replaceNode(context, aside)

  return CONTINUE
}

async function handleMermaid(tree: Root, file: VFile) {
  const mermaidNodes: [node: Code, context: VisitorContext][] = []

  visit(tree, 'code', (node, index, parent) => {
    if (node.lang === 'mermaid') {
      mermaidNodes.push([node, { file, index, parent }])
      return SKIP
    }

    return CONTINUE
  })

  await Promise.all(
    mermaidNodes.map(async ([node, context]) => {
      const html = toHtml(toHast(node))
      const processedHtml = await transformHtmlToString(html)

      replaceNode(context, { type: 'html', value: processedHtml })
    }),
  )
}

function getFrontmatterNodeValue(file: VFile, obsidianFrontmatter?: ObsidianFrontmatter) {
  const frontmatter: Frontmatter = {
    title: file.stem,
  }

  if (file.data.includeKatexStyles) {
    frontmatter.head = [
      {
        tag: 'link',
        attrs: {
          rel: 'stylesheet',
          href: 'https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css',
        },
      },
    ]
  }

  if (obsidianFrontmatter?.tags && obsidianFrontmatter.tags.length > 0) {
    frontmatter.tags = obsidianFrontmatter.tags
  }

  return yaml.stringify(frontmatter).trim()
}

function getFileUrl(output: StarlightObsidianConfig['output'], filePath: string, anchor?: string) {
  return `${path.posix.join('/', output, slugifyObsidianPath(filePath))}${slugifyObsidianAnchor(anchor ?? '')}`
}

function getRelativeFilePath(file: VFile, relativePath: string) {
  ensureTransformContext(file)

  return path.posix.join(getObsidianRelativePath(file.data.vault, file.dirname), relativePath)
}

function getFilePathFromVaultFile(vaultFile: VaultFile, url: string) {
  return vaultFile.uniqueFileName ? vaultFile.slug : slugifyObsidianPath(url)
}

function isMarkdownAsset(filePath: string, file: VFile) {
  return (
    (file.data.vault?.options.linkSyntax === 'markdown' && filePath.endsWith('.md')) ||
    getExtension(filePath).length === 0
  )
}

// Custom asset nodes are replaced by a custom HTML node, e.g. an audio player for audio files, etc.
function isCustomAsset(filePath: string) {
  return isObsidianAsset(filePath) && !isObsidianAsset(filePath, 'image')
}

function getCustomAssetNode(filePath: string): RootContent {
  if (isObsidianAsset(filePath, 'audio')) {
    return {
      type: 'html',
      value: `<audio class="sl-obs-embed-audio" controls src="${filePath}"></audio>`,
    }
  } else if (isObsidianAsset(filePath, 'video')) {
    return {
      type: 'html',
      value: `<video class="sl-obs-embed-video" controls src="${filePath}"></video>`,
    }
  }

  return {
    type: 'html',
    value: `<iframe class="sl-obs-embed-pdf" src="${filePath}"></iframe>`,
  }
}

function getMarkdownAssetNode(file: VFile, fileUrl: string): RootContent {
  ensureTransformContext(file)

  const fileExt = file.data.vault.options.linkSyntax === 'wikilink' ? '.md' : ''
  const filePath = decodeURIComponent(
    file.data.vault.options.linkFormat === 'relative' ? getRelativeFilePath(file, fileUrl) : fileUrl,
  )
  const url = path.join('/', `${filePath}${fileExt}`)

  const matchingFile = file.data.files.find((vaultFile) => vaultFile.path === url)

  if (!matchingFile) {
    return { type: 'text', value: '' }
  }

  const content = fs.readFileSync(matchingFile.fsPath, 'utf8')
  const root = transformMarkdownToAST(matchingFile.fsPath, content, file.data)

  return {
    type: 'blockquote',
    children: [
      {
        type: 'html',
        value: `<strong>${matchingFile.stem}</strong>`,
      },
      ...(root.children as BlockContent[]),
    ],
  }
}

function replaceNode({ index, parent }: VisitorContext, replacement: RootContent | RootContent[]) {
  if (!parent || index === undefined) {
    return
  }

  parent.children.splice(index, 1, ...(Array.isArray(replacement) ? replacement : [replacement]))
}

function ensureTransformContext(file: VFile): asserts file is VFile & { data: TransformContext; dirname: string } {
  if (!file.dirname || !file.data.files || file.data.output === undefined || !file.data.vault) {
    throw new Error('Invalid transform context.')
  }
}

export interface TransformContext {
  files: VaultFile[]
  includeKatexStyles?: boolean
  output: StarlightObsidianConfig['output']
  vault: Vault
}

interface VisitorContext {
  file: VFile
  index: number | undefined
  parent: Parent | undefined
}

interface Frontmatter {
  title: string | undefined
  tags?: string[]
  head?: { tag: string; attrs: Record<string, string> }[]
}

declare module 'vfile' {
  interface DataMap extends TransformContext {}
}
