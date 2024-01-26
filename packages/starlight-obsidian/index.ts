import type { StarlightPlugin, StarlightUserConfig } from '@astrojs/starlight/types'
import { z } from 'astro/zod'

import { starlightObsidianIntegration } from './libs/integration'
import { getObsidianPaths, getVault } from './libs/obsidian'
import { throwUserError } from './libs/plugin'
import { addObsidianFiles } from './libs/starlight'

const starlightObsidianConfigSchema = z.object({
  // TODO(HiDeoo)
  configFolder: z.string().startsWith('.').default('.obsidian'),
  // TODO(HiDeoo) doc with @default
  output: z.string().default('notes'),
  // TODO(HiDeoo) Add doc (absolute or relative path)
  // TODO(HiDeoo) vaultDir? Something else
  vault: z.string(),
})

export default function starlightObsidianPlugin(userConfig: StarlightObsidianUserConfig): StarlightPlugin {
  const parsedConfig = starlightObsidianConfigSchema.safeParse(userConfig)

  if (!parsedConfig.success) {
    throwUserError(
      `The provided plugin configuration is invalid.\n${parsedConfig.error.issues.map((issue) => issue.message).join('\n')}`,
    )
  }

  const config = parsedConfig.data

  return {
    name: 'starlight-obsidian-plugin',
    hooks: {
      async setup({ addIntegration, config: starlightConfig, logger, updateConfig }) {
        const vault = await getVault(config)
        const obsidianPaths = await getObsidianPaths(vault)
        await addObsidianFiles(config, vault, obsidianPaths)

        addIntegration(starlightObsidianIntegration())

        const updatedStarlightConfig: Partial<StarlightUserConfig> = {
          customCss: [...(starlightConfig.customCss ?? []), 'starlight-obsidian/styles'],
        }

        if (starlightConfig.components?.PageTitle) {
          logger.warn(
            'It looks like you already have a `PageTitle` component override in your Starlight configuration.',
          )
          logger.warn('To use `starlight-obsidian`, remove the override for the `PageTitle` component.\n')
        } else {
          updatedStarlightConfig.components = {
            PageTitle: 'starlight-obsidian/PageTitle.astro',
          }
        }

        updateConfig(updatedStarlightConfig)
      },
    },
  }
}

export type StarlightObsidianUserConfig = z.input<typeof starlightObsidianConfigSchema>
export type StarlightObsidianConfig = z.output<typeof starlightObsidianConfigSchema>
