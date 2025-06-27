import { GeneratorOptions } from '@prisma/generator-helper'
import { parseEnvValue } from '@prisma/internals'
import * as path from 'path'
import { GeneratorPathNotExists } from './error-handler'
import { PrismaConvertor } from './convertor'
import {
	getRelativeTSPath,
	parseBoolean,
	parseNumber,
	prettierFormat,
	writeTSFile,
} from './util'
import { INDEX_TEMPLATE } from './templates/index.template'
import { ImportComponent } from './components/import.component'
import * as prettier from 'prettier'
import { FileComponent } from './components/file.component'

export const GENERATOR_NAME = 'Prisma DB Model Generator'

export const PrismaClassGeneratorOptions = {
	makeIndexFile: {
		desc: 'make index file',
		defaultValue: true,
	},
	dryRun: {
		desc: 'dry run',
		defaultValue: true,
	},
	separateRelationFields: {
		desc: 'separate relation fields',
		defaultValue: false,
	},
	useSwagger: {
		desc: 'use swagger decorstor',
		defaultValue: true,
	},
	useGraphQL: {
		desc: 'use graphql',
		defaultValue: false,
	},
	useUndefinedDefault: {
		desc: 'use undefined default',
		defaultValue: false,
	},
} as const

export type PrismaClassGeneratorOptionsKeys =
	keyof typeof PrismaClassGeneratorOptions
export type PrismaClassGeneratorConfig = Partial<
	Record<PrismaClassGeneratorOptionsKeys, any>
>
export class PrismaClassGenerator {
	static instance: PrismaClassGenerator
	_options: GeneratorOptions
	_prettierOptions: prettier.Options
	rootPath: string
	clientPath: string

	constructor(options?: GeneratorOptions) {
		if (options) {
			this.options = options
		}
	}

	public get options() {
		return this._options
	}

	public set options(value) {
		this._options = value
	}

	public get prettierOptions() {
		return this._prettierOptions
	}

	public set prettierOptions(value) {
		this._prettierOptions = value
	}

	static async getInstance(options?: GeneratorOptions) {
		if (PrismaClassGenerator.instance) {
			return PrismaClassGenerator.instance
		}
		const instance = new PrismaClassGenerator(options)
		await instance.initPrettierOptions()
		PrismaClassGenerator.instance = instance
		return instance
	}

	async initPrettierOptions() {
		const output = parseEnvValue(this.options.generator.output!)
		this.prettierOptions =
			(await prettier.resolveConfig(output, { useCache: false })) ||
			(await prettier.resolveConfig(path.dirname(require.main.filename), {
				useCache: false,
			}))
	}

	getClientImportPath(from = this.rootPath) {
		if (!from || !this.clientPath) {
			throw new GeneratorPathNotExists()
		}

		const nmFolderName = 'node_modules'
		const nmPathIndex = this.clientPath.indexOf(nmFolderName)
		if (nmPathIndex >= 0) {
			const pathTillNmFolder = this.clientPath.substr(
				0,
				nmPathIndex + `${nmFolderName}/`.length,
			)
			return this.clientPath.replace(pathTillNmFolder, '')
		}

		return path.relative(from, this.clientPath).replace('node_modules/', '')
	}

	setPrismaClientPath(): void {
		const { otherGenerators, schemaPath } = this.options

		this.rootPath = schemaPath.replace('/prisma/schema.prisma', '')
		const defaultPath = path.resolve(
			this.rootPath,
			'node_modules/@prisma/client',
		)
		const clientGenerator = otherGenerators.find(
			(g) => g.provider.value === 'prisma-client-js',
		)

		this.clientPath = clientGenerator?.output.value ?? defaultPath
	}

	run = async (): Promise<void> => {
		const { generator, dmmf } = this.options
		const output = parseEnvValue(generator.output!)
		const config = this.getConfig()
		this.setPrismaClientPath()

		const convertor = PrismaConvertor.getInstance()
		convertor.dmmf = dmmf
		convertor.config = config

		const classes = convertor.getClasses()
		const files = classes.map(
			(classComponent) => new FileComponent({ classComponent, output }),
		)

		// Resolve imports for all files
		await Promise.all(files.map((file) => file.resolveImports()))

		const classToPath = files.reduce(
			(result, fileRow) => {
				const fullPath = path.resolve(fileRow.dir, fileRow.filename)
				result[fileRow.prismaClass.name] = fullPath
				return result
			},
			{} as Record<string, string>,
		)

		files.forEach((fileRow) => {
			fileRow.imports = fileRow.imports.map((importRow) => {
				const pathToReplace = importRow.getReplacePath(classToPath)
				if (pathToReplace !== null) {
					importRow.from = fileRow.getRelativePath(pathToReplace)
				}
				return importRow
			})
		})

		await Promise.all(files.map((fileRow) => fileRow.write(config.dryRun)))
		if (config.makeIndexFile) {
			const indexFilePath = path.resolve(output, 'index.ts')
			const imports = files.map(
				(fileRow) =>
					new ImportComponent(
						getRelativeTSPath(indexFilePath, fileRow.getPath()),
						fileRow.prismaClass.name,
					),
			)

			const content = INDEX_TEMPLATE.replace(
				'#!{IMPORTS}',
				imports.map((i) => i.echo('_')).join('\r\n'),
			)
				.replace(
					'#!{RE_EXPORT_CLASSES}',
					files
						.map((f) => `	${f.prismaClass.reExportPrefixed('_')}`)
						.join('\r\n'),
				)
				.replace(
					'#!{CLASSES}',
					files.map((f) => f.prismaClass.name).join(', '),
				)
			const formattedContent = await prettierFormat(
				content,
				this.prettierOptions,
			)
			writeTSFile(indexFilePath, formattedContent, config.dryRun)
		}
		return
	}

	getConfig = (): PrismaClassGeneratorConfig => {
		const config = this.options.generator.config

		const result: PrismaClassGeneratorConfig = {}
		for (const optionName in PrismaClassGeneratorOptions) {
			const { defaultValue } = PrismaClassGeneratorOptions[optionName]
			result[optionName] = defaultValue

			const value = config[optionName]
			if (value) {
				if (typeof defaultValue === 'boolean') {
					result[optionName] = parseBoolean(value)
				} else if (typeof defaultValue === 'number') {
					result[optionName] = parseNumber(value)
				} else {
					result[optionName] = value
				}
			}
		}

		return result
	}
}
