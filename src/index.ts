import * as path from 'path';
import * as fs from 'fs-extra';
import * as _ from 'lodash';
import * as globby from 'globby';
import * as ts from 'typescript';
import * as yaml from 'js-yaml';
import * as gqlCli from '@graphql-codegen/cli';

import { generateRoutes, generateSpec } from 'tsoa';

import * as typescript from './typescript';
import { watchFiles } from './watchFiles';
import { ExtendedRoutesConfig, ExtendedSpecConfig } from '@tsoa/cli';

const SERVERLESS_FOLDER = '.serverless';
const BUILD_FOLDER = '.build';
const TSOA_CONFIG_FILE = 'tsoa.json';
const GQL_CODEGEN_CONFIG_FILE = 'codegen.yml';
const SHARED_CONFIG_PROPERTIES = [
  'entryFile',
  'noImplicitAdditionalProperties',
  'controllerPathGlobs',
];
export class TypeScriptPlugin {
  private originalServicePath: string;
  private isWatching: boolean;

  serverless: Serverless.Instance;
  options: Serverless.Options;
  hooks: { [key: string]: Function };

  constructor(serverless: Serverless.Instance, options: Serverless.Options) {
    this.serverless = serverless;
    this.options = options;

    this.hooks = {
      'before:run:run': async () => {
        await this.generateSpecAndRoutes();
        await this.generateGraphqlTypes();
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
      },
      'before:offline:start': async () => {
        await this.generateSpecAndRoutes();
        await this.generateGraphqlTypes();
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
        this.watchAll();
      },
      'before:offline:start:init': async () => {
        await this.generateSpecAndRoutes();
        await this.generateGraphqlTypes();
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
        this.watchAll();
      },
      'before:package:createDeploymentArtifacts': async () => {
        await this.generateSpecAndRoutes();
        await this.generateGraphqlTypes();
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies(true);
      },
      'after:package:createDeploymentArtifacts': async () => {
        await this.cleanup();
      },
      'before:deploy:function:packageFunction': async () => {
        await this.generateSpecAndRoutes();
        await this.generateGraphqlTypes();
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies(true);
      },
      'after:deploy:function:packageFunction': async () => {
        await this.cleanup();
      },
      'before:invoke:local:invoke': async () => {
        await this.generateSpecAndRoutes();
        await this.generateGraphqlTypes();
        const emitedFiles = await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
        if (this.isWatching) {
          emitedFiles.forEach((filename) => {
            const module = require.resolve(
              path.resolve(this.originalServicePath, filename)
            );
            delete require.cache[module];
          });
        }
      },
      'after:invoke:local:invoke': () => {
        if (this.options.watch) {
          this.watchFunction();
          this.serverless.cli.log('Waiting for changes...');
        }
      },
    };
  }

  get functions() {
    const { options } = this;
    const { service } = this.serverless;

    if (options.function) {
      return {
        [options.function]: service.functions[this.options.function],
      };
    }

    return service.functions;
  }

  get rootFileNames() {
    return typescript.extractFileNames(
      this.originalServicePath,
      this.serverless.service.provider.name,
      this.functions
    );
  }

  prepare() {
    // exclude serverless-plugin-typescript
    for (const fnName in this.functions) {
      const fn = this.functions[fnName];
      fn.package = fn.package || {
        exclude: [],
        include: [],
      };

      // Add plugin to excluded packages or an empty array if exclude is undefined
      fn.package.exclude = _.uniq([
        ...(fn.package.exclude || []),
        'node_modules/serverless-plugin-typescript',
      ]);
    }
  }

  get graphqlFilePaths() {
    const paths = ['gql', 'graphql'].map(
      (extension) => `${process.cwd()}/**/*.${extension}`
    );
    return paths;
  }
  getGqlCodegenConfig(cwd = process.cwd(), logger) {
    const configFilePath = path.join(cwd, GQL_CODEGEN_CONFIG_FILE);

    if (fs.existsSync(configFilePath)) {
      const gqlCodegenConfig = yaml.load(
        fs.readFileSync(configFilePath, 'utf8')
      ) as { generates: any };

      if (gqlCodegenConfig) {
        return { generates: gqlCodegenConfig.generates };
      }

      if (logger) {
        logger.log(
          `No ${GQL_CODEGEN_CONFIG_FILE} config found at root level...`
        );
      }
    }

    return {};
  }

  async generateGraphqlTypes() {
    this.serverless.cli.log('Generate graphql types...');
    const { generates } = this.getGqlCodegenConfig(
      this.originalServicePath,
      this.isWatching ? null : this.serverless.cli
    );

    await gqlCli.generate(
      {
        schema: this.graphqlFilePaths,
        generates,
      },
      true
    );

    this.serverless.cli.log('GraphQL Types Generation Complete...');
  }

  async watchFunction(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.serverless.cli.log(`Watch function ${this.options.function}...`);

    this.isWatching = true;
    watchFiles(
      this.rootFileNames,
      this.originalServicePath,
      () => {
        this.serverless.pluginManager.spawn('invoke:local');
      },
      this.generateGraphqlTypes.bind(this),
      this.graphqlFilePaths
    );
  }

  async watchAll(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.serverless.cli.log(`Watching typescript files...`);

    this.isWatching = true;
    watchFiles(
      this.rootFileNames,
      this.originalServicePath,
      this.compileTs.bind(this),
      this.generateGraphqlTypes.bind(this),
      this.graphqlFilePaths
    );
  }

  async compileTs(): Promise<string[]> {
    this.prepare();
    this.serverless.cli.log('Compiling with Typescript...');

    if (!this.originalServicePath) {
      // Save original service path and functions
      this.originalServicePath = this.serverless.config.servicePath;
      // Fake service path so that serverless will know what to zip
      this.serverless.config.servicePath = path.join(
        this.originalServicePath,
        BUILD_FOLDER
      );
    }

    const tsconfig = typescript.getTypescriptConfig(
      this.originalServicePath,
      this.isWatching ? null : this.serverless.cli
    );

    tsconfig.outDir = BUILD_FOLDER;

    const emitedFiles = await typescript.run(this.rootFileNames, tsconfig);
    this.serverless.cli.log('Typescript compiled.');
    return emitedFiles;
  }

  /** Link or copy extras such as node_modules or package.include definitions */
  async copyExtras() {
    const { service } = this.serverless;

    // include any "extras" from the "include" section
    if (service.package.include && service.package.include.length > 0) {
      const files = await globby(service.package.include);

      for (const filename of files) {
        const destFileName = path.resolve(path.join(BUILD_FOLDER, filename));
        const dirname = path.dirname(destFileName);

        if (!fs.existsSync(dirname)) {
          fs.mkdirpSync(dirname);
        }

        if (!fs.existsSync(destFileName)) {
          fs.copySync(
            path.resolve(filename),
            path.resolve(path.join(BUILD_FOLDER, filename))
          );
        }
      }
    }
  }

  /**
   * Copy the `node_modules` folder and `package.json` files to the output
   * directory.
   * @param isPackaging Provided if serverless is packaging the service for deployment
   */
  async copyDependencies(isPackaging = false) {
    const outPkgPath = path.resolve(path.join(BUILD_FOLDER, 'package.json'));
    const outModulesPath = path.resolve(
      path.join(BUILD_FOLDER, 'node_modules')
    );

    // copy development dependencies during packaging
    if (isPackaging) {
      if (fs.existsSync(outModulesPath)) {
        fs.unlinkSync(outModulesPath);
      }

      fs.copySync(
        path.resolve('node_modules'),
        path.resolve(path.join(BUILD_FOLDER, 'node_modules'))
      );
    } else {
      if (!fs.existsSync(outModulesPath)) {
        await this.linkOrCopy(
          path.resolve('node_modules'),
          outModulesPath,
          'junction'
        );
      }
    }

    // copy/link package.json
    if (!fs.existsSync(outPkgPath)) {
      await this.linkOrCopy(path.resolve('package.json'), outPkgPath, 'file');
    }
  }

  /**
   * Move built code to the serverless folder, taking into account individual
   * packaging preferences.
   */
  async moveArtifacts(): Promise<void> {
    const { service } = this.serverless;

    await fs.copy(
      path.join(this.originalServicePath, BUILD_FOLDER, SERVERLESS_FOLDER),
      path.join(this.originalServicePath, SERVERLESS_FOLDER)
    );

    if (this.options.function) {
      const fn = service.functions[this.options.function];
      fn.package.artifact = path.join(
        this.originalServicePath,
        SERVERLESS_FOLDER,
        path.basename(fn.package.artifact)
      );
      return;
    }

    if (service.package.individually) {
      const functionNames = service.getAllFunctions();
      functionNames.forEach((name) => {
        service.functions[name].package.artifact = path.join(
          this.originalServicePath,
          SERVERLESS_FOLDER,
          path.basename(service.functions[name].package.artifact)
        );
      });
      return;
    }

    service.package.artifact = path.join(
      this.originalServicePath,
      SERVERLESS_FOLDER,
      path.basename(service.package.artifact)
    );
  }

  async cleanup(): Promise<void> {
    await this.moveArtifacts();
    // Restore service path
    this.serverless.config.servicePath = this.originalServicePath;
    // Remove temp build folder
    fs.removeSync(path.join(this.originalServicePath, BUILD_FOLDER));
  }

  /**
   * Attempt to symlink a given path or directory and copy if it fails with an
   * `EPERM` error.
   */
  private async linkOrCopy(
    srcPath: string,
    dstPath: string,
    type?: fs.FsSymlinkType
  ): Promise<void> {
    return fs.symlink(srcPath, dstPath, type).catch((error) => {
      if (error.code === 'EPERM' && error.errno === -4048) {
        return fs.copy(srcPath, dstPath);
      }
      throw error;
    });
  }
  private async generateSpecAndRoutes(): Promise<void> {
    this.serverless.cli.log('Generate API Routes...');

    const logger = this.isWatching ? null : this.serverless.cli;
    const compilerOptions = typescript.getTypescriptConfig(
      this.originalServicePath || process.cwd(),
      logger
    );
    const { specConfig, routesConfig, ignorePaths } =
      this.getSpecAndRoutesConfig(this.originalServicePath, logger);

    await generateSpec(specConfig, compilerOptions, ignorePaths);
    await generateRoutes(routesConfig, compilerOptions, ignorePaths);

    this.serverless.cli.log('API Route Generation Complete...');
  }

  private getSpecAndRoutesConfig(
    cwd: string | undefined = process.cwd(),
    logger?: { log: (str: string) => void }
  ): {
    specConfig: ExtendedSpecConfig;
    routesConfig: ExtendedRoutesConfig;
    ignorePaths: string[] | undefined;
  } {
    let specConfig: ExtendedSpecConfig = {
      entryFile: 'api/App.ts',
      noImplicitAdditionalProperties: 'silently-remove-extras',
      outputDirectory: 'build',
      controllerPathGlobs: ['**/*.controller.ts'],
      specVersion: 3,
      securityDefinitions: {
        api_key: {
          type: 'apiKey',
          name: 'x-api-key',
          in: 'header',
          description: 'API Key',
        },
      },
    };
    let routesConfig: ExtendedRoutesConfig = {
      entryFile: 'api/App.ts',
      controllerPathGlobs: ['**/*.controller.ts'],
      noImplicitAdditionalProperties: 'silently-remove-extras',
      routesDir: 'build',
      authenticationModule: 'api/middleware/auth.ts',
    };
    let ignorePaths = undefined;
    let logMessage = `No ${TSOA_CONFIG_FILE} config found, using defaults...`;
    const configFilePath = path.join(cwd, TSOA_CONFIG_FILE);

    if (fs.existsSync(configFilePath)) {
      const configFileText = fs.readFileSync(configFilePath).toString();
      const result = ts.parseConfigFileTextToJson(
        configFilePath,
        configFileText
      );

      if (!result.error) {
        logMessage = `Using local ${TSOA_CONFIG_FILE} config...`;

        const tsoaConfig = result.config;

        if (tsoaConfig) {
          if (tsoaConfig.spec) {
            specConfig = { ...specConfig, ...tsoaConfig.spec };
          }
          if (tsoaConfig.routes) {
            routesConfig = { ...routesConfig, ...tsoaConfig.routes };
          }
          if (tsoaConfig.ignore) {
            ignorePaths = tsoaConfig.ignore;
          }

          SHARED_CONFIG_PROPERTIES.forEach((sharedKey) => {
            const sharedValue = tsoaConfig[sharedKey];

            if (sharedValue) {
              specConfig[sharedKey] = sharedValue;
              routesConfig[sharedKey] = sharedValue;
            }
          });
        }
      }
    }

    if (logger) {
      logger.log(logMessage);
    }

    return { specConfig, routesConfig, ignorePaths };
  }
}

module.exports = TypeScriptPlugin;
