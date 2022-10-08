import path from 'path';
import vm from 'vm';
import fs from 'fs-extra';
import fsPromises from 'fs/promises';

import { meteorNameToNodeName, meteorNameToNodePackageDir } from './helpers/helpers.js';

import { getPackageGlobals, replaceGlobalsInFile, globalStaticImports, maybeCleanASTs } from './helpers/globals.js';
import packageJsContext from './helpers/package-js-context.js';
import { getImportTreeForFile } from './helpers/imports.js';
import { getExportStr, getExportMainModuleStr } from './helpers/content.js';

const supportedISOPackBuilds = new Map([
  ['web.browser', 'client'],
  ['os', 'server'],
]);

const commonJS = new Set([
  'jquery',
  'underscore',
  'momentjs:moment',
  'softwarerero:accounts-t9n',
]);

const excludes = new Set([
  'ecmascript',
  'typescript',
  'modules',
  'less',
  'minifiers',
  'isobuild:compiler-plugin',
  'isobuild:dynamic-import', // TODO?
  'ecmascript-runtime-client', // TODO?
  'ecmascript-runtime-server', // TODO?
  'isobuild:minifier-plugin',
  'standard-minifier-css',
  'standard-minifier-js',
  'hot-module-replacement', // this has a strong dependency on modules
]);
export const packageMap = new Map();

function sortImports(imports) {
  imports.sort((a, b) => {
    const aIsAbsolute = a.match(/^[@\/]/);
    const bIsAbsolute = b.match(/^[@\/]/);
    if (aIsAbsolute && bIsAbsolute) {
      return 0;
    }
    if (!aIsAbsolute && !bIsAbsolute) {
      return 0;
    }
    if (aIsAbsolute && !bIsAbsolute) {
      return -1;
    }
    if (!aIsAbsolute && bIsAbsolute) {
      return 1;
    }
    return 0;
  });
  return imports;
}

function getImportStr(importsSet, isCommon) {
  if (isCommon) {
    return sortImports(Array.from(importsSet)).map((imp) => `require("${imp}");`).join('\n');
  }

  return sortImports(Array.from(importsSet)).map((imp) => `import "${imp}";`).join('\n');
}

const meteorVersionPlaceholderSymbol = Symbol('meteor-version-placeholder');

class MeteorPackage {
  #folderName;

  #meteorName;

  #nodeName;

  #version;

  #description;

  #dependencies = {};

  #peerDependencies = {};

  #optionalDependencies = {};

  #serverJsExports = [];

  #clientJsExports = [];

  #clientJsImports = new Set();

  #serverJsImports = new Set();

  #impliedClientPackages = new Set();

  #impliedServerPackages = new Set();

  #allPackages = new Set();

  // non weak, non unordered
  #immediateDependencies = new Set();

  #imports = {};

  #serverMainModule;

  #clientMainModule;

  #clientAssets = [];

  #serverAssets = [];

  #waitingWrite = [];


  #isoResourcesToCopy = new Map();

  #folderPath;

  #isISOPack = false;

  static PackageNameToFolderPaths = new Map();

  #archsForFiles = new Map();

  #loadedPromise;
  
  #loadedResolve;

  #writtenPromise;
  
  #alreadyWritten;
  
  #writtenResolve;

  constructor(meteorName) {
    this.#meteorName = meteorName;
    this.#writtenPromise = new Promise((resolve) => {
      this.#writtenResolve = resolve;
    });
    this.#loadedPromise = new Promise((resolve) => {
      this.#loadedResolve = resolve;
    });
  }

  get folderName() {
    return this.#meteorName.replace(':', '_');
  }

  static meteorNameToNodeName(name) {
    return meteorNameToNodeName(name);
  }

  static nodeNameToMeteorName(name) {
    if (name.startsWith('@meteor/')) {
      return name.split('/')[1];
    }
    return name.slice(1).split('/').join(':');
  }

  isCommon() {
    return commonJS.has(this.#meteorName);
  }

  setBasic({ name, description, version }) {
    this.#meteorName = name || this.#meteorName;
    this.#nodeName = MeteorPackage.meteorNameToNodeName(name || this.#meteorName);
    this.#description = description;

    // semver doesn't support _
    this.#version = version.replace('_', '-');
  }

  addExports(symbols, archs, opts) {
    symbols.forEach((symbol) => {
      if ((!opts?.testOnly && !archs?.length) || archs.includes('server')) {
        this.#serverJsExports.push(symbol);
      }
      if ((!opts?.testOnly && !archs?.length) || archs.includes('client') || archs.includes('web') || archs.includes('web.browser')) {
        this.#clientJsExports.push(symbol);
      }
    });
  }

  addNpmDeps(deps) {
    Object.assign(this.#dependencies, deps);
  }

  addImport(item, archs) {
    if (!archs?.length || archs.includes('server')) {
      this.#serverJsImports.add(item);
    }
    if (!archs?.length || archs.includes('client') || archs.includes('web') || archs.includes('web.browser')) {
      this.#clientJsImports.add(item);
    }
  }

  addAssets(files, archs) {
    files.forEach((file) => {
      if (!archs?.length || archs.includes('client') || archs.includes('web') || archs.includes('web.browser')) {
        this.#clientAssets.push(file);
      }
      if (!archs?.length || archs.includes('server')) {
        this.#serverAssets.push(file);
      }
    });
  }

  addMeteorDependencies(packages, archs, opts) {
    // a hack - a lot of our local packages just assume Mongo will be present.
    if (this.#meteorName.startsWith('qualia:')) {
      this.#dependencies['@meteor/mongo'] = meteorVersionPlaceholderSymbol;
      this.#allPackages.add('mongo');
      this.#immediateDependencies.add('mongo');
      if (!this.isCommon()) {
        this.addImport('@meteor/mongo', ['client', 'server']);
      }
    }
    if (this.#nodeName !== '@meteor/meteor') {
      // TODO: hack - figure out how to deal with the global problem. In Meteor we need the global to be a package global, everywhere else we need it to be actually global (unless it's imported from meteor)
      this.#dependencies['@meteor/meteor'] = meteorVersionPlaceholderSymbol;
      this.#allPackages.add('meteor');
      this.#immediateDependencies.add('meteor');

      // why does this condition need to be here and not above? It seems like all packages (e.g., underscore) need the `allPackages` and `dependencies` set,
      // but common mustn't import.
      if (!this.isCommon()) {
        this.addImport('@meteor/meteor', ['client', 'server']);
      }
    }
    let deps = this.#dependencies;
    if (opts?.unordered) {
      // TODO: I think this is a problem with the local file install.
      deps = this.#peerDependencies;
    }
    else if (opts?.weak) {
      deps = this.#optionalDependencies;
    }
    packages.forEach((dep) => {
      const [name] = dep.split('@');
      if (excludes.has(name)) {
        return;
      }
      if (!opts?.weak) {
        this.#allPackages.add(name);
      }
      const nodeName = MeteorPackage.meteorNameToNodeName(name);
      // we should probably NEVER use version, since we can't do resolution the way we want (at least until all versions are published to npm)
      deps[nodeName] = meteorVersionPlaceholderSymbol;
      // TODO: how to ensure the package is available when the dependency is weak?
      if (!opts?.unordered && !opts?.weak) {
        this.addImport(nodeName, archs);
        this.#immediateDependencies.add(name);
      }
      // TODO: other opts?
    });
  }

  addImplies(packages, archs) {
    packages.forEach((dep) => {
      const [name] = dep.split('@');
      if (excludes.has(name)) {
        return;
      }
      this.#allPackages.add(name);
      const nodeName = MeteorPackage.meteorNameToNodeName(name);

      // we should probably NEVER use version, since we can't do resolution the way we want (at least until all versions are published to npm)
      this.#dependencies[nodeName] = meteorVersionPlaceholderSymbol;
      this.#immediateDependencies.add(name);
      if (!archs?.length || archs.includes('server')) {
        this.#serverJsImports.add(nodeName);
        this.#impliedServerPackages.add(nodeName);
      }
      if (!archs?.length || archs.includes('client')) {
        this.#clientJsImports.add(nodeName);
        this.#impliedClientPackages.add(nodeName);
      }
    });
  }


  setMainModule(file, archs) {
    if (!archs?.length || archs.includes('server')) {
      this.#serverMainModule = `./${file}`;
    }
    if (!archs?.length || archs.includes('client')) {
      this.#clientMainModule = `./${file}`;
    }
  }

  toJSON() {
    const newDependencies = Object.fromEntries(Object.entries(this.#dependencies).map(([name, version]) => {
      if (version === meteorVersionPlaceholderSymbol) {
        // didn't know you could call a private member of something other than this...
        const importedPackage = packageMap.get(MeteorPackage.nodeNameToMeteorName(name));
        if (!importedPackage) {
          throw new Error(`depending on missing package ${MeteorPackage.nodeNameToMeteorName(name)}`);
        }
        return [name, importedPackage.#version];
      }
      return [name, version];
    }));
    return {
      name: this.#nodeName,
      version: this.#version,
      description: this.#description,
      dependencies: newDependencies,
      peerDependencies: this.#peerDependencies,
      optionalDependencies: this.#optionalDependencies,
      exports: {
        '.': {
          node: {
            import: './__server.js',
            require: !commonJS.has(this.#meteorName) ? './__server.cjs' : undefined,
          },
          default: {
            import: './__client.js',
            require: !commonJS.has(this.#meteorName) ? './__client.cjs' : undefined,
          },
        },
        './*': './*',
      },
      imports: this.#imports,
      exportedVars: {
        server: this.#serverJsExports,
        client: this.#clientJsExports,
      },
      assets: {
        client: this.#clientAssets,
        server: this.#serverAssets,
      },
      type: commonJS.has(this.#meteorName) ? 'commonjs' : 'module',
      implies: {
        client: Array.from(this.#impliedClientPackages),
        server: Array.from(this.#impliedServerPackages),
      },
    };
  }

  getImportedGlobalsMaps(globals) {
    const clientMap = new Map();
    const serverMap = new Map();
    globals.forEach((global) => {
      if (globalStaticImports.has(global) && globalStaticImports.get(global) !== this.#nodeName) {
        clientMap.set(global, globalStaticImports.get(global));
        serverMap.set(global, globalStaticImports.get(global));
      }
    });
    Object.keys(this.#dependencies)
      .forEach((dep) => {
        const packageName = MeteorPackage.nodeNameToMeteorName(dep);
        const meteorPackage = packageMap.get(packageName);
        if (!meteorPackage) {
        // it wasn't a meteor dep.
          return;
        }
        const { clientMap: depClientMap, serverMap: depServerMap } = meteorPackage.getImportedGlobalsMaps(globals);
        depClientMap.forEach((providingDep, exp) => {
          clientMap.set(exp, providingDep);
        });
        depServerMap.forEach((providingDep, exp) => {
          serverMap.set(exp, providingDep);
        });
        meteorPackage.getImplies('client')
          .forEach((imp) => {
            const impPackageName = MeteorPackage.nodeNameToMeteorName(imp);
            const impliedPackage = packageMap.get(impPackageName);
            impliedPackage.getExportedVars('client')
              .forEach((exp) => {
                if (globals.has(exp)) {
                  clientMap.set(exp, imp);
                }
              });
          });
        meteorPackage.getExportedVars('client')
          .forEach((exp) => {
            if (globals.has(exp)) {
              clientMap.set(exp, dep);
            }
          });
        meteorPackage.getImplies('server')
          .forEach((imp) => {
            const impPackageName = MeteorPackage.nodeNameToMeteorName(imp);
            const impliedPackage = packageMap.get(impPackageName);
            impliedPackage.getExportedVars('server')
              .forEach((exp) => {
                if (globals.has(exp)) {
                  serverMap.set(exp, imp);
                }
              });
          });
        meteorPackage.getExportedVars('server')
          .forEach((exp) => {
            if (globals.has(exp)) {
              serverMap.set(exp, dep);
            }
          });
      });
    
    return { clientMap, serverMap };
  }

  getImplies(clientOrServer) {
    if (!clientOrServer) {
      return Array.from(new Set([
        ...this.#impliedServerPackages,
        ...this.#impliedClientPackages,
      ]));
    }
    return clientOrServer === 'server' ? this.#impliedServerPackages : this.#impliedClientPackages;
  }

  getExportedVars(clientOrServer) {
    if (!clientOrServer) {
      return Array.from(new Set([
        ...this.#serverJsExports,
        ...this.#clientJsExports,
      ]));
    }
    return clientOrServer === 'server' ? this.#serverJsExports : this.#clientJsExports;
  }

  async writeToNpmModule(outputParentFolder) {
    await this.#loadedPromise;
    if (this.#alreadyWritten) {
      await this.#writtenPromise;
      return;
    }
    this.#alreadyWritten = true;
    let state = 0;
    try {
      await Promise.all(Array.from(this.#immediateDependencies).map((p) => packageMap.get(p).writeToNpmModule(outputParentFolder)))
      state = 1;
      const outputFolder = path.resolve(`${outputParentFolder}/${meteorNameToNodePackageDir(this.#meteorName)}`);
      if (this.#isISOPack) {
        await this.#copyISOPackResources(outputFolder);
      }
      else {
        await fs.copy(
          this.#folderPath,
          outputFolder,
          {
            filter(src) {
              return !src.includes('.npm');
            },
          },
        );
      }
      state = 2;
      const exportedMap = new Map();
      await maybeCleanASTs(outputFolder, commonJS.has(this.#meteorName), exportedMap);
      if (this.#serverMainModule) {
        await getImportTreeForFile(outputFolder, path.resolve(outputFolder, this.#serverMainModule), 'server', this.#archsForFiles);
      }
      if (this.#clientMainModule) {
        await getImportTreeForFile(outputFolder, path.resolve(outputFolder, this.#clientMainModule), 'client', this.#archsForFiles);
      }
      // must happen after getting the import tree.
      await Promise.all(Array.from(this.#clientJsImports).map(async (file) => {
        if (file.startsWith('.')) {
          await getImportTreeForFile(outputFolder, path.resolve(outputFolder, file), 'client', this.#archsForFiles);
        }
      }));
      await Promise.all(Array.from(this.#serverJsImports).map(async (file) => {
        if (file.startsWith('.')) {
          await getImportTreeForFile(outputFolder, path.resolve(outputFolder, file), 'server', this.#archsForFiles);
        }
      }));
      const { all: globalsByFile, assigned: packageGlobalsByFile } = await getPackageGlobals(outputFolder, commonJS.has(this.#meteorName));
      if (this.#meteorName === 'browser-policy') { // TODO? Why did I make this specific to one package?!
        exportedMap.forEach((exported, file) => {
          const localFile = file.replace(outputFolder, '.');
          if (localFile === this.#serverMainModule) {
            this.#serverJsExports = Array.from(new Set([...this.#serverJsExports, ...exported.filter(Boolean)]));
          }
          if (localFile === this.#clientJsExports) {
            this.#clientJsExports = Array.from(new Set([...this.#clientJsExports, ...exported.filter(Boolean)]));
          }
        });
      }
      const allGlobals = new Set(Array.from(globalsByFile.values()).flatMap((v) => Array.from(v)));
      const packageGlobals = new Set(Array.from(packageGlobalsByFile.values()).flatMap((v) => Array.from(v)));
      const { clientMap, serverMap } = this.getImportedGlobalsMaps(allGlobals);

      // these are all the globals USED in the package. Not just those assigned. 
      // TODO: this should go away, but is needed for the exports/require/module hack below
      const badPackageGlobals = Array.from(allGlobals)
        .filter((global) => !clientMap.has(global) && !serverMap.has(global));
      
      const archsForFiles = this.#archsForFiles;
      await Promise.all(Array.from(globalsByFile.entries()).map(([file, globals]) => replaceGlobalsInFile(
        outputFolder,
        globals,
        file,
        { clientMap, serverMap },
        this.isCommon(),
        (name) => packageMap.get(name),
        archsForFiles.get(file.replace(outputFolder, '.')),
        packageGlobals,
      )));
      state = 3;

      if (badPackageGlobals.length || this.#serverJsExports.length || this.#clientJsExports.length) {
        const exportNamesSet = new Set([
          ...this.#serverJsExports,
          ...this.#clientJsExports,
          ...badPackageGlobals,
        ]);

        const hasRequire = exportNamesSet.has('require');
        const hasExports = exportNamesSet.has('exports');
        const hasModule = exportNamesSet.has('module');
        const hasNpm = exportNamesSet.has('Npm');
        const hasAssets = exportNamesSet.has('Assets');
        exportNamesSet.delete('require');
        exportNamesSet.delete('module');
        exportNamesSet.delete('Npm');
        exportNamesSet.delete('Assets');
        if (hasAssets) {
          this.#imports['#assets'] = {
            node: './__server_assets.js',
            default: './__client_assets.js',
          };
          await Promise.all([
            fs.writeFile(
              `${outputFolder}/__client_assets.js`,
              'export default {}',
            ),
            fs.writeFile(
              `${outputFolder}/__server_assets.js`,
              [
                'import fs from \'fs\';',
                'import fsPromises from \'fs/promises\';',
                'import Fiber from \'fibers\';',
                'import path from \'path\';',
                'const basePath = path.dirname(import.meta.url).replace(\'file:\', \'\')',
                'export default {',
                '  getText(file) {',
                '    return Fiber.current ? Promise.await(fsPromises.readFile(path.join(basePath, file))).toString() : fs.readFileSync(path.join(basePath, file)).toString();',
                '  }',
                '};',
              ].join('\n'),
            ),
          ]);
        }
        if ((hasRequire || hasExports) && this.#serverMainModule) {
          console.warn(`esm module ${this.#meteorName} using exports or require, this probably wont work`);
        }
        if ((hasModule || hasNpm || hasRequire) && !this.isCommon()) {
          this.#imports['#module'] = {
            node: './__server_module.js',
            default: './__client_module.js',
          };
          await fsPromises.writeFile(
            `${outputFolder}/__client_module.js`,
            `export default {
              createRequire() {return require}
            };
            `,
          );
          await fsPromises.writeFile(
            `${outputFolder}/__server_module.js`,
            "export { default } from 'node:module'",
          );
        }
        if (this.isCommon()) {
          await fsPromises.writeFile(
            `${outputFolder}/__globals.js`,
            // TODO support assets for cjs
            Array.from(exportNamesSet).map((name) => `module.exports.${name} = undefined;`).join('\n'),
          );
        }
        else {
          await fsPromises.writeFile(
            `${outputFolder}/__globals.js`,
            [
              ...(hasModule || hasNpm || hasRequire ? ['import module from "#module";'] : []),
              ...hasAssets ? ['import Assets from \'#assets\''] : [],
              'export default {',
              ...(exportNamesSet.size ? [`  ${Array.from(exportNamesSet).map((name) => `${name}: undefined`).join(',\n  ')},`] : []),
              ...(hasNpm ? ['  Npm: { require: module.createRequire(import.meta.url) },'] : []),
              ...(hasModule ? ['  module: { id: import.meta.url },'] : []),
              ...(hasRequire ? ['  require: module.createRequire(import.meta.url),'] : []),
              ...(hasAssets ? ['Assets'] : []),
              '}',
            ].join('\n'),
          );
        }
      }
      state = 4;
      if (!this.isCommon()) {
        fsPromises.writeFile(
          `${outputFolder}/__server.cjs`,
          `module.exports = Package["${this.#meteorName}"];`,
        );
        fsPromises.writeFile(
          `${outputFolder}/__client.cjs`,
          `module.exports = Package["${this.#meteorName}"];`,
        );
      }
      state = 5;
      await Promise.all([
        fsPromises.writeFile(
          `${outputFolder}/package.json`,
          JSON.stringify(this.toJSON(), null, 2),
        ),
        fsPromises.writeFile(
          `${outputFolder}/__server.js`,
          [
            getImportStr(this.#serverJsImports, commonJS.has(this.#meteorName)),
            ...(this.#serverMainModule ? [await getExportMainModuleStr(this.#meteorName, this.#serverMainModule, outputFolder, this.isCommon())] : []),
            getExportStr(
              this.#meteorName,
              'server',
              this.#serverJsExports,
              this.#serverJsImports,
              this.isCommon(),
              (name) => packageMap.get(name),
              this.#serverMainModule,
            ),
          ].join('\n'),
        ),
        fsPromises.writeFile(
          `${outputFolder}/__client.js`,
          [
            getImportStr(this.#clientJsImports, commonJS.has(this.#meteorName)),
            ...(this.#clientMainModule ? [await getExportMainModuleStr(this.#meteorName, this.#clientMainModule, outputFolder, this.isCommon())] : []),
            getExportStr(
              this.#meteorName,
              'client',
              this.#clientJsExports,
              this.#clientJsImports,
              this.isCommon(),
              (name) => packageMap.get(name),
              this.#clientMainModule,
            ),
          ].join('\n'),
        ),
      ]);
      state = 6;
    }
    catch (error) {
      console.log(this.#meteorName, outputParentFolder, state);
      console.error(error);
      process.exit();
      throw error;
    }
    finally {
      this.#writtenResolve();
    }
  }

  async #copyISOPackResources(outputFolder) {
    await fs.ensureDir(outputFolder);
    return Promise.all(Array.from(this.#isoResourcesToCopy.entries()).map(async ([dest, src]) => {
      await fs.ensureDir(path.dirname(path.join(outputFolder, dest)));
      return fsPromises.copyFile(path.join(this.#folderPath, src), path.join(outputFolder, dest));
    }));
  }

  async #loadISOBuild(json, clientOrServer) {
    json.uses.forEach(({ package: packageName, weak, unordered }) => {
      this.addMeteorDependencies([packageName], [clientOrServer], { weak, unordered });
    });
    json.resources.forEach(({ path: aPath, file, type, servePath }) => {
      if (!aPath && type !== 'source') {
        // iron_dynamic-template has a compiled version of dynamic_template.html I think
        // this needs to be imported as normal, but it doesn't have a "path"
        aPath = servePath.split('/').slice(3).join('/');
        this.addImport(`./${aPath}`, [clientOrServer]);
      }
      if (type === 'source' && aPath.startsWith('/packages/')) {
        aPath = aPath.replace('/packages/', `/${clientOrServer}/`);
      }
      this.#isoResourcesToCopy.set(aPath, file);
    });
    if (json.node_modules) {
      const npmShrinkwrapJsonPath = path.join(this.#folderPath, json.node_modules, '.npm-shrinkwrap.json');
      if (await fs.pathExists(npmShrinkwrapJsonPath)) {
        const npmShrinkwrapJson = JSON.parse((await fsPromises.readFile(npmShrinkwrapJsonPath)).toString());
        Object.entries(npmShrinkwrapJson.dependencies).forEach(([name, { version }]) => {
          this.#dependencies[name] = version;
        });
      }
    }
    json.resources
      .filter(({ type, fileOptions: { lazy } = {} }) => type === 'source' && lazy !== true)
      .forEach(({ path: aPath }) => {
        if (aPath.startsWith('/packages/')) {
          aPath = aPath.replace('/packages/', `/${clientOrServer}/`);
        }
        this.addImport(`./${aPath}`, [clientOrServer]);
      });

    json.resources
      .filter(({ type }) => type === 'asset')
      .forEach(({ path: aPath }) => {
        this.addAssets([aPath], [clientOrServer]);
      });
    if (json.declaredExports) {
      json.declaredExports.forEach(({ name, testOnly }) => {
        if (!testOnly) {
          this.addExports([name], [clientOrServer]);
        }
      });
    }
  }

  async loadFromISOPack(meteorInstall, ...otherPaths) {
    this.#isISOPack = true;
    const folderName = (this.#meteorName).split(':').join('_');
    if (!await fs.pathExists(meteorInstall)) {
      throw new Error('Meteor not installed');
    }
    const basePath = path.join(meteorInstall, 'packages', folderName);

    if (!await fs.pathExists(basePath)) {
      throw new Error('Package not installed by meteor');
    }
    const names = (await fsPromises.readdir(basePath)).filter((name) => !name.startsWith('.'));
    const fullFolder = path.join(basePath, names.slice(-1)[0]);
    this.#folderPath = fullFolder;
    const isopack = JSON.parse((await fsPromises.readFile(path.join(fullFolder, 'isopack.json'))).toString())['isopack-2'];
    this.setBasic({
      name: isopack.name,
      description: isopack.summary,
      version: isopack.version,
    });
    const builds = isopack.builds.filter((build) => supportedISOPackBuilds.has(build.arch));
    await Promise.all(builds.map(async (build) => {
      const buildJson = JSON.parse((await fsPromises.readFile(path.join(fullFolder, build.path))).toString());
      return this.#loadISOBuild(buildJson, supportedISOPackBuilds.get(build.arch));
    }));

    // first make sure all impled or used packages are loaded
    this.#waitingWrite = (await Promise.all(
      Array.from(this.#allPackages).map((packageName) => MeteorPackage.ensurePackage(
        packageName,
        meteorInstall,
        ...otherPaths,
      )),
    )).filter(Boolean);
  }

  async loadFromMeteorPackage(meteorInstall, ...otherPaths) {
    try {
      const packageJsPath = await this.findPackageJs(...otherPaths);
      if (!packageJsPath) {
        await this.loadFromISOPack(meteorInstall, ...otherPaths);
        return;
      }
      this.#folderPath = path.dirname(packageJsPath);
      const script = new vm.Script((await fsPromises.readFile(packageJsPath)).toString());
      const context = packageJsContext(this);
      try {
        script.runInNewContext(context);
      }
      catch (e) {
        console.error(`problem parsing ${this.#meteorName}`);
        throw e;
      }
      packageMap.set(this.#meteorName, this);

      // first make sure all impled or used packages are loaded
      this.#waitingWrite = (await Promise.all(
        Array.from(this.#allPackages).map(async (packageName) => {
          try {
            return await MeteorPackage.ensurePackage(
              packageName,
              meteorInstall,
              ...otherPaths,
            );
          }
          catch (e) {
            e.message = `Couldn't ensure ${packageName} because ${e.message}`;
            throw e;
          }
        }),
      )).filter(Boolean);
      // next, find all the direct dependencies and see what they imply. Then add those to our dependencies
      Object.keys(this.#dependencies)
        .forEach((dep) => {
          const importedPackage = packageMap.get(MeteorPackage.nodeNameToMeteorName(dep));
          if (!importedPackage) {
            // was't a meteor package...
            return;
          }
          importedPackage.getImplies('client').forEach((name) => this.addImport(name, 'client'));
          importedPackage.getImplies('server').forEach((name) => this.addImport(name, 'server'));
        });
    }
    catch (error) {
      console.log(this.#meteorName || this.#folderName);
      console.error(error);
      throw error;
    }
    finally {
      this.#loadedResolve();
    }
  }

  async convert(meteorInstall, outputParentFolder, ...packagesPaths) {
    await this.loadFromMeteorPackage(meteorInstall, ...packagesPaths);
    await this.writeToNpmModule(outputParentFolder);
  }

  async findPackageJs(...packagesPaths) {
    const folders = MeteorPackage.foldersToSearch(...packagesPaths);
    const tempPrioMap = new Map();
    if (!MeteorPackage.PackageNameToFolderPaths.size) {
      const allFolders = (await Promise.all(folders.map(async (folder) => {
        if (!await fs.pathExists(folder)) {
          return [];
        }
        const innerFolders = await fsPromises.readdir(folder, { withFileTypes: true });
        return innerFolders.filter((innerFolder) => innerFolder.isDirectory).map((innerFolder) => path.join(folder, innerFolder.name));
      }))).flat();
      (await Promise.all(allFolders.map(async (folder, index) => {
        const packageJsPath = path.join(folder, 'package.js');
        if (!await fs.pathExists(packageJsPath)) {
          return false;
        }
        const packageJs = (await fs.readFile(packageJsPath)).toString();
        const hasName = packageJs.match(/Package\.describe\(\{[^}]+['"]?name['"]?\s*:\s*['"]([a-zA-Z0-9:-]+)["']/);
        const name = hasName ? hasName[1] : folder.split('/').slice(-1)[0];
        if (!tempPrioMap.has(name) || tempPrioMap.get(name) > index) {
          tempPrioMap.set(name, index);
          MeteorPackage.PackageNameToFolderPaths.set(name, packageJsPath);
        }
      })));
    }
    return MeteorPackage.PackageNameToFolderPaths.get(this.#meteorName);
  }

  static foldersToSearch(...packagesPaths) {
    // hack, until we move to using ISOPacks for core/non-core packages.
    return packagesPaths.flatMap((subPath) => [subPath, path.join(subPath, 'non-core'), path.join(subPath, 'deprecated')]);
  }

  static async ensurePackage(name, meteorInstall, ...packagesPaths) {
    // TODO: search for packages with this name rather than assuming name === folderName
    if (!packageMap.has(name)) {
      const meteorPackage = new MeteorPackage(name);
      packageMap.set(name, meteorPackage);
      await meteorPackage.loadFromMeteorPackage(meteorInstall, ...packagesPaths);
      return meteorPackage;
    }

    // if we aren't building a package, return false
    return false;
  }
}

// TODO: we're overloading name here.
export async function convertPackage(meteorName, outputParentFolder, meteorInstall, ...otherPackageFolders) {
  const absoluteOutputParentFolder = path.resolve(outputParentFolder);
  if (excludes.has(meteorName) || packageMap.has(meteorName)) {
    return;
  }
  const meteorPackage = new MeteorPackage(meteorName);
  packageMap.set(meteorName, meteorPackage);
  await meteorPackage.convert(absoluteOutputParentFolder, meteorInstall, ...otherPackageFolders);
}

/* convertPackage(
  process.argv[2],
  process.argv[3],
  ...process.argv.slice(4).map(v => v.replace(/\/$/, ""))
).catch(console.error);
*/
