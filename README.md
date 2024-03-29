# serverless-plugin-typescript-tsoa-gql

Forked from: [serverless-plugin-tsoa](https://github.com/dgocoder/serverless-plugin-tsoa) and [serverless-plugin-typescript-graphql-codegen](https://github.com/kevinschaffter/serverless-plugin-typescript-graphql-codegen)

Serverless plugin for zero-config Typescript with support for [tsoa](https://tsoa-community.github.io/docs/getting-started.html) and [graphql codegen](https://graphql-code-generator.com/)

## Features

* Zero-config: Works out of the box without the need to install any other compiler or plugins
* Supports ES2015 syntax + features (`export`, `import`, `async`, `await`, `Promise`, ...)
* Supports `sls package`, `sls deploy` and `sls deploy function`
* Supports `sls invoke local` + `--watch` mode
* Integrates nicely with [`serverless-offline`](https://github.com/dherault/serverless-offline)
* Generates GraphQL types for file extensions `.gql` and `.graphql` (uses codegen). This is skipped if no `codegen.yml` file is found on the root of the project.

## Install

```sh
yarn add --dev serverless-plugin-tsoa typescript
# or
npm install -D serverless-plugin-tsoa typescript
```

Add the following plugin to your `serverless.yml`:

```yaml
plugins:
  - serverless-plugin-tsoa
```

## Configure

See [example folder](example) for a minimal example.

### `tsconfig.json`

The default `tsconfig.json` file used by the plugin looks like this:

```json
{
  "compilerOptions": {
    "preserveConstEnums": true,
    "strictNullChecks": true,
    "sourceMap": true,
    "allowJs": true,
    "target": "es5",
    "outDir": ".build",
    "moduleResolution": "node",
    "lib": ["es2015"],
    "rootDir": "./"
  }
}
```

> Note 1: The `outDir` and `rootDir` options cannot be overwritten.

> Note 2: Don't confuse the [`tsconfig.json`](tsconfig.json) in this repository with the one mentioned above.

### Including extra files

All files from `package/include` will be included in the final build file. See [Exclude/Include](https://serverless.com/framework/docs/providers/aws/guide/packaging#exclude--include)


### GraphQL Code Generation

Make sure to have a `codegen.yml` file at the root of your repository:

```yaml
overwrite: true
schema: ./**/*.schema.gql
generates:
  src/generated/graphql.ts:
    plugins:
      - 'typescript'
    config:
      skipTypename: true
      constEnums: false
      typesPrefix: I
      enumPrefix: false
      declarationKind: 'interface'
      namingConvention:
        typeNames: pascal-case#pascalCase
        enumValues: upper-case#upperCase
```

## Usage

### Google Cloud Functions

When using with Google Cloud Functions via the [serverless-google-cloudfunctions](https://github.com/serverless/serverless-google-cloudfunctions)
plugin, you simply have to provide a `main` field in your `package.json`:

```js
{
  // ...
  "main": "handler.js",
  // ..
}
```

And this plugin will automatically compile your typescript correctly. Note
that the field must refer to the compiled file name, namely, ending with a `.js`
extension.

If a `main` field was not found, then this plugin will use `index.js`. Before
compilation begins, it will check to see that the file indicated exists with a
`.ts` extension before actually trying to compile it.

### Automatic compilation

The normal Serverless deploy procedure will automatically compile with Typescript:

- Create the Serverless project with `serverless create -t aws-nodejs`
- Install Serverless Typescript as above
- Deploy with `serverless deploy`

### Usage with serverless-offline

The plugin integrates very well with [serverless-offline](https://github.com/dherault/serverless-offline) to
simulate AWS Lambda and AWS API Gateway locally.

Add the plugins to your `serverless.yml` file and make sure that `serverless-plugin-tsoa`
precedes `serverless-offline` as the order is important:
```yaml
  plugins:
    ...
    - serverless-plugin-tsoa
    ...
    - serverless-offline
    ...
```

Run `serverless offline` or `serverless offline start` to start the Lambda/API simulation.

In comparison to `serverless offline`, the `start` command will fire an `init` and a `end` lifecycle hook which is needed for `serverless-offline` and e.g. `serverless-dynamodb-local` to switch off resources (see below)

#### serverless-dynamodb-local

Configure your service the same as mentioned above, but additionally add the `serverless-dynamodb-local`
plugin as follows:
```yaml
  plugins:
    - serverless-plugin-tsoa
    - serverless-dynamodb-local
    - serverless-offline
```

Run `serverless offline start`.

#### Other useful options

You can reduce the clutter generated by `serverless-offline` with `--dontPrintOutput` and
disable timeouts with `--noTimeout`.

### Run a function locally

To run your compiled functions locally you can:

```bash
$ serverless invoke local --function <function-name>
```

Options are:

- `--function` or `-f` (required) is the name of the function to run
- `--watch` - recompile and run a function locally on source changes
- `--path` or `-p` (optional) path to JSON or YAML file holding input data
- `--data` or `-d` (optional) input data

### Enabling source-maps

You can easily enable support for source-maps (making stacktraces easier to read) by installing and using the following plugin:

```sh
yarn add --dev source-map-support
```

```ts
// inside of your function
import 'source-map-support/register'
```

If you are using webpack (most likely). Add `devtool: 'source-map'` to `webpack.config.js`:
```js
module.exports = {
  .... snip ....
  devtool: 'source-map',
  .... snip ....

}
```
