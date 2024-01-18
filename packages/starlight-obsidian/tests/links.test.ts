import { expect, test } from 'vitest'

import { getObsidianPaths, getObsidianVaultFiles, getVault } from '../libs/obsidian'

import { getFixtureConfig, transformFixtureMdFile } from './utils'

test('support Markdown links using the shortest format', async () => {
  const fixtureName = 'markdown-links-shortest'

  const vault = await getVault(getFixtureConfig(fixtureName))
  const paths = await getObsidianPaths(vault)
  const files = getObsidianVaultFiles(vault, paths)
  const md = await transformFixtureMdFile(fixtureName, 'root 1.md', { context: { files, output: 'notes', vault } })

  expect(md).toMatchInlineSnapshot(`
    "[root 2](/notes/root-2)

    [file in folder 1](/notes/folder/file-in-folder-1)

    [file in nested folder 1](/notes/folder/nested-folder/file-in-nested-folder-1)

    [duplicate file name](/notes/duplicate-file-name)

    [duplicate file name](/notes/folder/duplicate-file-name)

    [duplicate file name](/notes/folder/nested-folder/duplicate-file-name)
    "
  `)
})
